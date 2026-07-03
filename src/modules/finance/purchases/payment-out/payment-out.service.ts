import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { trace } from '@opentelemetry/api';
import { ClientSession, Model, Types } from 'mongoose';
import { PaymentOut } from './payment-out.schema';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';
import { PurchaseBill } from '../purchase-bill/purchase-bill.schema';
import { TdsService } from '../tds/tds.service';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { IdempotencyService } from '../../sales/common/idempotency.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { FirmsService } from '../../firms/firms.service';
import { PartiesService } from '../../parties/parties.service';
import { CreatePaymentOutDto } from './dto/create-payment-out.dto';
import { FyLockService } from '../../fiscal-year/fy-lock.service';

/**
 * PaymentOutService — vendor payment lifecycle.
 * State machine: draft → posted → (cancelled only from draft)
 *
 * post() runs inside a MongoDB transaction:
 *   1. Assign voucherNumber via VoucherSeries
 *   2. Re-validate bill allocations inside transaction (race-safe, T-F04-02-03)
 *   3. Compute TDS at payment time (194C/194H/194J via TdsService, $inc)
 *   4. Compute netPaidPaise and allocatedToCreditorsAfterTds94qPaise
 *   5. Apply $inc on PurchaseBill.amountPaidPaise / amountDuePaise; update paymentStatus
 *   6. Post double-entry via LedgerPostingService.postPaymentOut
 *   7. Set state='posted', save
 */
@Injectable()
export class PaymentOutService {
  private readonly logger = new Logger(PaymentOutService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(PaymentOut.name) private readonly model: Model<PaymentOut>,
    @InjectModel(PurchaseBill.name) private readonly billModel: Model<PurchaseBill>,
    private readonly tdsService: TdsService,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly idempotencyService: IdempotencyService,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly firmsService: FirmsService,
    private readonly partiesService: PartiesService,
    private readonly fyLock: FyLockService,
    // Phase 17 / FIN-16-03 — party.timeline emit (D-17 non-blocking).
    private readonly events: EventEmitter2,
    private readonly postHog: PostHogService,
  ) {}

  async createDraft(
    wsId: string,
    firmId: string,
    dto: CreatePaymentOutDto,
    userId: string,
  ): Promise<PaymentOut> {
    return withFinanceSpan(
      this.tracer,
      'finance.createPaymentOut',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, new Date(dto.paymentDate));

        // Pre-validate allocations at draft create (re-validated atomically inside post() transaction)
        const totalAllocated = dto.billAllocations.reduce((s, a) => s + a.allocatedPaise, 0);
        const unappliedPaise = dto.unappliedPaise ?? dto.totalAmountPaise - totalAllocated;
        if (unappliedPaise < 0) {
          throw new BadRequestException(
            `sum(allocations)=${totalAllocated} exceeds totalAmountPaise=${dto.totalAmountPaise}`,
          );
        }

        // Cross-firm safety: scope each bill query to wsId+firmId (T-F04-02-06)
        for (const alloc of dto.billAllocations) {
          const bill = await this.billModel
            .findOne({
              _id: new Types.ObjectId(alloc.billId),
              workspaceId: new Types.ObjectId(wsId),
              firmId: new Types.ObjectId(firmId),
              isDeleted: false,
            })
            .exec();
          if (!bill) throw new NotFoundException(`Bill ${alloc.billId} not found`);
          if (alloc.allocatedPaise > bill.amountDuePaise) {
            throw new BadRequestException(
              `allocatedPaise=${alloc.allocatedPaise} exceeds amountDuePaise=${bill.amountDuePaise} for bill ${bill.voucherNumber ?? alloc.billId}`,
            );
          }
        }

        const party = await this.partiesService.findOne(wsId, firmId, dto.partyId);
        const partySnapshot = dto.partySnapshot ?? {
          name: (party as any).name,
          gstin: (party as any).gstin,
        };

        const doc = new this.model({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          // FY is server-authoritative: derive from the payment date (post() re-derives
          // with the firm's fyStartMonth). Never trust a client-supplied financialYear.
          financialYear: this.voucherSeriesService.getFYForDate(new Date(dto.paymentDate)),
          paymentDate: dto.paymentDate,
          partyId: new Types.ObjectId(dto.partyId),
          partySnapshot,
          paymentMode: dto.paymentMode,
          bankAccountId: dto.bankAccountId ? new Types.ObjectId(dto.bankAccountId) : undefined,
          referenceNo: dto.referenceNo,
          referenceDate: dto.referenceDate,
          totalAmountPaise: dto.totalAmountPaise,
          billAllocations: dto.billAllocations.map((a) => ({
            billId: new Types.ObjectId(a.billId),
            billNumber: a.billNumber,
            billDuePaise: a.billDuePaise,
            allocatedPaise: a.allocatedPaise,
            runningDuePaise: a.billDuePaise - a.allocatedPaise,
          })),
          unappliedPaise,
          state: 'draft',
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
        });
        const saved = await doc.save();
        // Fire-and-forget product analytics on the successful draft write (ids only, no PII).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.created_payment_out',
          properties: { workspaceId: wsId, firmId, paymentOutId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async post(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
    idempotencyKey?: string,
  ): Promise<PaymentOut> {
    return withFinanceSpan(
      this.tracer,
      'finance.postPaymentOut',
      { workspaceId: wsId, firmId, userId },
      async () => {
        if (idempotencyKey) {
          const cached = await this.idempotencyService.getCached<PaymentOut>(
            `post-pout:${firmId}`,
            idempotencyKey,
          );
          if (cached) return cached;
          const acquired = await this.idempotencyService.tryAcquireLock(
            `post-pout:${firmId}`,
            idempotencyKey,
            120,
          );
          if (!acquired)
            throw new BadRequestException('Concurrent post in progress — retry after a moment');
        }

        // Pre-flight check outside transaction (cheap early exit for obvious bad states)
        const preCheck = await this.findOne(wsId, firmId, id);
        if (!preCheck) throw new NotFoundException('PaymentOut not found');

        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, preCheck.paymentDate);
        if (preCheck.state !== 'draft') {
          throw new BadRequestException(`Cannot post PaymentOut in state '${preCheck.state}'`);
        }

        const firm = await this.firmsService.findOne(wsId, firmId);
        if (!firm) throw new NotFoundException('Firm not found');
        // Party fetched using pre-check partyId; stable reference — parties don't change mid-transaction
        const party = await this.partiesService.findOne(wsId, firmId, preCheck.partyId.toString());
        if (!party) throw new NotFoundException('Party not found');

        const conn = this.model.db;
        const result = await (conn as any).transaction(async (session: ClientSession) => {
          // Re-fetch inside transaction with session lock to prevent stale-allocation race (WR-02)
          const paymentOut = await this.model
            .findOne({
              _id: new Types.ObjectId(id),
              workspaceId: new Types.ObjectId(wsId),
              firmId: new Types.ObjectId(firmId),
              isDeleted: false,
            })
            .session(session)
            .exec();
          if (!paymentOut) throw new NotFoundException('PaymentOut not found');
          if (paymentOut.state !== 'draft') {
            throw new BadRequestException(`Cannot post PaymentOut in state '${paymentOut.state}'`);
          }

          // FY is server-authoritative: derive from the payment date so a back-dated
          // payment is numbered into its true fiscal year (and honours the FY-lock).
          paymentOut.financialYear = this.voucherSeriesService.getFYForDate(
            new Date(paymentOut.paymentDate),
            (firm as any).fyStartMonth ?? 4,
          );
          // 1. Assign voucher number
          paymentOut.voucherNumber = await this.voucherSeriesService.generateNextNumber(
            firmId,
            'payment_out',
            paymentOut.financialYear,
          );

          // 2. Re-validate allocations inside transaction (prevents race condition T-F04-02-03)
          let totalAllocated = 0;
          let anyReverseCharge = false;
          for (const alloc of paymentOut.billAllocations) {
            const bill = await this.billModel
              .findOne({
                _id: alloc.billId,
                workspaceId: new Types.ObjectId(wsId),
                firmId: new Types.ObjectId(firmId),
              })
              .session(session)
              .exec();
            if (!bill) throw new BadRequestException(`Bill ${alloc.billNumber} not found`);
            if (alloc.allocatedPaise > bill.amountDuePaise) {
              throw new BadRequestException(
                `Allocation ${alloc.allocatedPaise} exceeds bill ${alloc.billNumber} due ${bill.amountDuePaise}`,
              );
            }
            if (bill.isReverseCharge) anyReverseCharge = true;
            totalAllocated += alloc.allocatedPaise;
          }

          // 2b. RCM payment voucher (Sec 31(3)(g) / Rule 52): a recipient paying a
          // reverse-charge supplier issues a payment voucher at the time of payment.
          if (anyReverseCharge) {
            const pvNumber = await this.voucherSeriesService.generateNextNumber(
              firmId,
              'rcm_payment_voucher',
              paymentOut.financialYear,
            );
            paymentOut.rcmPaymentVoucher = {
              number: pvNumber,
              date: new Date(paymentOut.paymentDate),
            };
          }

          // 3. Compute TDS at payment time (194C/194H/194J — NOT 194Q which is at bill post)
          const tdsBase = paymentOut.totalAmountPaise; // gross before TDS deduction
          const tds = await this.tdsService.computeAtPaymentOut(
            paymentOut.workspaceId,
            paymentOut.firmId,
            {
              _id: (party as any)._id,
              supplierType: (party as any).supplierType,
              deducteeStatus: (party as any).deducteeStatus,
              pan: (party as any).pan,
            },
            tdsBase,
            paymentOut.financialYear,
            session,
          );
          if (tds) paymentOut.tdsApplied = tds;

          // 4. Compute net amounts
          paymentOut.netPaidPaise = paymentOut.totalAmountPaise - (tds?.tdsPaise ?? 0);
          // Dr Sundry Creditors = sum of bill allocations (194Q was already deducted at PB post)
          paymentOut.allocatedToCreditorsAfterTds94qPaise = totalAllocated;

          // 5. Apply $inc on each PurchaseBill — atomic, never read-then-write
          for (const alloc of paymentOut.billAllocations) {
            const updated = await this.billModel
              .findOneAndUpdate(
                {
                  _id: alloc.billId,
                  workspaceId: new Types.ObjectId(wsId),
                  firmId: new Types.ObjectId(firmId),
                },
                {
                  $inc: {
                    amountPaidPaise: alloc.allocatedPaise,
                    amountDuePaise: -alloc.allocatedPaise,
                  },
                },
                { new: true, session },
              )
              .exec();
            if (!updated) continue;

            const newStatus =
              updated.amountDuePaise <= 0
                ? 'paid'
                : updated.amountPaidPaise > 0
                  ? 'partial'
                  : 'unpaid';
            await this.billModel.updateOne(
              { _id: alloc.billId },
              { $set: { paymentStatus: newStatus } },
              { session },
            );
            alloc.runningDuePaise = updated.amountDuePaise;
          }

          // 6. Double-entry ledger posting
          await this.ledgerPostingService.postPaymentOut(paymentOut, {
            session,
            userId,
            firm: firm,
          });

          // 7. Mark posted
          paymentOut.state = 'posted';
          paymentOut.postedBy = new Types.ObjectId(userId);
          paymentOut.postedAt = new Date();
          (paymentOut.auditLog as any[]).push({
            at: new Date(),
            by: new Types.ObjectId(userId),
            action: 'posted',
          });

          return (paymentOut as any).save({ session });
        });

        if (idempotencyKey) {
          await this.idempotencyService.store(`post-pout:${firmId}`, idempotencyKey, result);
        }

        // Phase 17 / FIN-16-03 — payment.sent emit AFTER commit (D-17 non-blocking).
        try {
          this.events.emit('party.timeline', {
            type: 'payment.sent',
            workspaceId: wsId,
            firmId,
            partyId: result.partyId,
            refModel: 'PaymentOut',
            refId: result._id,
            occurredAt: result.paymentDate ?? new Date(),
            actorUserId: userId,
            summary: `Payment sent via ${result.paymentMode}`,
            meta: {
              amountPaise: result.totalAmountPaise,
              mode: result.paymentMode,
            },
          });
        } catch (err) {
          this.logger.warn(
            `party.timeline emit failed for payment.sent (id=${result._id}): ${(err as Error)?.message ?? String(err)}`,
          );
        }

        // Fire-and-forget product analytics on the successful post (ids / voucher no / amount only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.posted_payment_out',
          properties: {
            workspaceId: wsId,
            firmId,
            paymentOutId: String(result._id),
            voucherNumber: result.voucherNumber,
            totalAmountPaise: result.totalAmountPaise,
          },
        });
        return result;
      },
    );
  }

  async cancel(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
    reason?: string,
  ): Promise<PaymentOut> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelPaymentOut',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const paymentOut = await this.findOne(wsId, firmId, id);
        if (!paymentOut) throw new NotFoundException('PaymentOut not found');
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, paymentOut.paymentDate);
        if (paymentOut.state === 'posted') {
          throw new BadRequestException(
            'Posted payment-outs cannot be cancelled directly. Reversal is handled in F-07.',
          );
        }
        if (paymentOut.state === 'cancelled') {
          throw new BadRequestException('PaymentOut is already cancelled');
        }
        paymentOut.state = 'cancelled';
        (paymentOut.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'cancelled',
          reason,
        });
        const saved = await (paymentOut as any).save();
        // Fire-and-forget product analytics on the successful cancel (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.cancelled_payment_out',
          properties: { workspaceId: wsId, firmId, paymentOutId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async updateDraft(
    wsId: string,
    firmId: string,
    id: string,
    dto: Partial<CreatePaymentOutDto>,
    userId: string,
  ): Promise<PaymentOut> {
    return withFinanceSpan(
      this.tracer,
      'finance.updatePaymentOut',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const paymentOut = await this.findOne(wsId, firmId, id);
        if (!paymentOut) throw new NotFoundException('PaymentOut not found');
        if (paymentOut.state !== 'draft') {
          throw new BadRequestException(`Cannot update PaymentOut in state '${paymentOut.state}'`);
        }
        // F-15 Plan 03: FY-lock guard against BOTH old and new paymentDate
        await this.fyLock.assertOpen(wsId, firmId, paymentOut.paymentDate);
        if (dto.paymentDate) {
          await this.fyLock.assertOpen(wsId, firmId, new Date(dto.paymentDate));
        }
        // Whitelist allowed fields — prevents client injecting state/workspaceId/firmId
        const allowed: (keyof CreatePaymentOutDto)[] = [
          'financialYear',
          'paymentDate',
          'partyId',
          'partySnapshot',
          'paymentMode',
          'bankAccountId',
          'referenceNo',
          'referenceDate',
          'totalAmountPaise',
          'billAllocations',
          'unappliedPaise',
        ];
        for (const key of allowed) {
          if (key in dto) (paymentOut as any)[key] = (dto as any)[key];
        }
        (paymentOut.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'updated',
        });
        const saved = await (paymentOut as any).save();
        // Fire-and-forget product analytics on the successful draft update (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.updated_payment_out',
          properties: { workspaceId: wsId, firmId, paymentOutId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async softDelete(wsId: string, firmId: string, id: string, userId: string): Promise<PaymentOut> {
    return withFinanceSpan(
      this.tracer,
      'finance.deletePaymentOut',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const paymentOut = await this.findOne(wsId, firmId, id);
        if (!paymentOut) throw new NotFoundException('PaymentOut not found');
        if (paymentOut.state === 'posted') {
          throw new BadRequestException('Posted payment-outs cannot be deleted');
        }
        (paymentOut as any).isDeleted = true;
        (paymentOut as any).deletedAt = new Date();
        (paymentOut.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'deleted',
        });
        const saved = await (paymentOut as any).save();
        // Fire-and-forget product analytics on the successful soft-delete (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.deleted_payment_out',
          properties: { workspaceId: wsId, firmId, paymentOutId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async findOne(wsId: string, firmId: string, id: string): Promise<PaymentOut | null> {
    return this.model
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
  }

  async list(
    wsId: string,
    firmId: string,
    query: {
      partyId?: string;
      state?: string;
      dateFrom?: string | Date;
      dateTo?: string | Date;
      q?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<PaymentOut[]> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.state) filter.state = query.state;
    if (query.dateFrom || query.dateTo) {
      filter.paymentDate = {};
      // Coerce to Date: the HTTP query arrives as ISO strings, and a string vs Date field
      // comparison would not match in Mongo.
      if (query.dateFrom) filter.paymentDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.paymentDate.$lte = new Date(query.dateTo);
    }
    // Party search (q): voucher number prefix or party name. Mirrors the sale-invoice list
    // filter. Regex metachars escaped (WR-05).
    if (query.q) {
      const escapedQ = String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { voucherNumber: { $regex: `^${escapedQ}`, $options: 'i' } },
        { 'partySnapshot.name': { $regex: escapedQ, $options: 'i' } },
      ];
    }
    const limit = query.limit ?? 50;
    const skip = ((query.page ?? 1) - 1) * limit;
    return this.model.find(filter).sort({ paymentDate: -1 }).skip(skip).limit(limit).exec();
  }
}
