import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { trace } from '@opentelemetry/api';
import { Model, Types, ClientSession } from 'mongoose';
import { PaymentReceipt, PaymentAllocation } from './payment-receipt.schema';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { IdempotencyService } from '../../sales/common/idempotency.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { FirmsService } from '../../firms/firms.service';
import { PartiesService } from '../../parties/parties.service';
import { CreatePaymentReceiptDto } from './dto/create-payment-receipt.dto';
import { BrokerCommissionService } from '../broker-commission/broker-commission.service';
import { FyLockService } from '../../fiscal-year/fy-lock.service';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class PaymentReceiptService {
  private readonly logger = new Logger(PaymentReceiptService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Spans wrap each write; PostHog fires fire-and-forget after a successful write.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(PaymentReceipt.name)
    private readonly paymentReceiptModel: Model<PaymentReceipt>,
    @InjectModel(SaleInvoice.name)
    private readonly saleInvoiceModel: Model<SaleInvoice>,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly idempotencyService: IdempotencyService,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly firmsService: FirmsService,
    private readonly partiesService: PartiesService,
    private readonly brokerCommissionService: BrokerCommissionService,
    private readonly fyLock: FyLockService,
    // Phase 17 / FIN-16-03 — party.timeline emit (D-17 non-blocking).
    private readonly events: EventEmitter2,
    private readonly postHog: PostHogService,
  ) {}

  // ─── createDraft ──────────────────────────────────────────────────────────

  async createDraft(
    wsId: string,
    firmId: string,
    dto: CreatePaymentReceiptDto,
    userId: string,
  ): Promise<PaymentReceipt> {
    return withFinanceSpan(
      this.tracer,
      'finance.createPaymentReceipt',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, new Date(dto.receiptDate as any));

        // Validate total vs allocations
        const allocatedTotal = dto.allocations.reduce((s, a) => s + a.allocatedPaise, 0);
        const unappliedPaise = dto.totalAmountPaise - allocatedTotal;
        if (unappliedPaise < 0) {
          throw new BadRequestException(
            `sum(allocations.allocatedPaise)=${allocatedTotal} exceeds totalAmountPaise=${dto.totalAmountPaise}`,
          );
        }

        // Validate each allocation against invoice amountDuePaise (cross-firm safe)
        for (const alloc of dto.allocations) {
          const invoice = await this.saleInvoiceModel
            .findOne({
              _id: new Types.ObjectId(alloc.invoiceId),
              workspaceId: new Types.ObjectId(wsId),
              firmId: new Types.ObjectId(firmId),
              isDeleted: false,
            })
            .exec();
          if (!invoice) {
            throw new NotFoundException(`Invoice ${alloc.invoiceId} not found`);
          }
          if (alloc.allocatedPaise > invoice.amountDuePaise) {
            throw new BadRequestException(
              `allocatedPaise=${alloc.allocatedPaise} exceeds amountDuePaise=${invoice.amountDuePaise} for invoice ${invoice.voucherNumber ?? alloc.invoiceId}`,
            );
          }
        }

        // Build partySnapshot
        const party = await this.partiesService.findOne(wsId, firmId, dto.partyId);
        const partySnapshot = { name: (party as any).name, gstin: (party as any).gstin };

        // Build allocations sub-documents (compute runningDuePaise per allocation)
        const runningMap: Record<string, number> = {};
        const allocDocs: PaymentAllocation[] = [];
        for (const alloc of dto.allocations) {
          if (!(alloc.invoiceId in runningMap)) {
            const inv = await this.saleInvoiceModel
              .findOne({ _id: new Types.ObjectId(alloc.invoiceId) })
              .exec();
            runningMap[alloc.invoiceId] = inv?.amountDuePaise ?? alloc.invoiceDuePaise;
          }
          const runningDuePaise = runningMap[alloc.invoiceId] - alloc.allocatedPaise;
          runningMap[alloc.invoiceId] = runningDuePaise;
          allocDocs.push({
            invoiceId: new Types.ObjectId(alloc.invoiceId),
            invoiceNumber: alloc.invoiceNumber,
            invoiceDuePaise: alloc.invoiceDuePaise,
            allocatedPaise: alloc.allocatedPaise,
            runningDuePaise,
          } as PaymentAllocation);
        }

        const receipt = new this.paymentReceiptModel({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          // FY is server-authoritative: derive from the receipt date (post() re-derives
          // with the firm's fyStartMonth). Never trust a client-supplied financialYear.
          financialYear: this.voucherSeriesService.getFYForDate(new Date(dto.receiptDate)),
          receiptDate: dto.receiptDate,
          partyId: new Types.ObjectId(dto.partyId),
          partySnapshot,
          paymentMode: dto.paymentMode,
          bankAccountId: dto.bankAccountId ? new Types.ObjectId(dto.bankAccountId) : undefined,
          referenceNo: dto.referenceNo,
          referenceDate: dto.referenceDate,
          totalAmountPaise: dto.totalAmountPaise,
          allocations: allocDocs,
          unappliedPaise,
          state: 'draft',
          brokerPartyId: dto.brokerPartyId ? new Types.ObjectId(dto.brokerPartyId) : undefined,
          onlinePaymentId: dto.onlinePaymentId,
          onlinePaymentGateway: dto.onlinePaymentGateway,
          autoReconciled: false,
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'draft_created' }],
        });

        const saved = await receipt.save();
        // Fire-and-forget product analytics on the successful draft write (ids/amount only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.created_payment_receipt',
          properties: {
            workspaceId: wsId,
            firmId,
            receiptId: String(saved._id),
            paymentMode: dto.paymentMode,
            totalAmountPaise: dto.totalAmountPaise,
            allocationCount: dto.allocations.length,
          },
        });
        return saved;
      },
    );
  }

  // ─── updateDraft ──────────────────────────────────────────────────────────

  async updateDraft(
    wsId: string,
    firmId: string,
    id: string,
    dto: Partial<CreatePaymentReceiptDto>,
    userId: string,
  ): Promise<PaymentReceipt> {
    return withFinanceSpan(
      this.tracer,
      'finance.updatePaymentReceipt',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const receipt = await this.findOne(wsId, firmId, id);
        if (receipt.state !== 'draft') {
          throw new BadRequestException('Only draft receipts can be updated');
        }
        // F-15 Plan 03: FY-lock guard against BOTH old and new receiptDate
        await this.fyLock.assertOpen(wsId, firmId, receipt.receiptDate);
        if (dto.receiptDate) {
          await this.fyLock.assertOpen(wsId, firmId, new Date(dto.receiptDate as any));
        }
        Object.assign(receipt, dto);
        (receipt.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'draft_updated',
        });
        return (receipt as any).save();
      },
    );
  }

  // ─── postPaymentReceipt ───────────────────────────────────────────────────

  async postPaymentReceipt(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
    idempotencyKey?: string,
  ): Promise<PaymentReceipt> {
    return withFinanceSpan(
      this.tracer,
      'finance.postPaymentReceipt',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // Idempotency — return cached result if already posted with same key
        if (idempotencyKey) {
          const cached = await this.idempotencyService.getCached<PaymentReceipt>(
            `post-receipt:${firmId}`,
            idempotencyKey,
          );
          if (cached) return cached;
          const locked = await this.idempotencyService.tryAcquireLock(
            `post-receipt:${firmId}`,
            idempotencyKey,
            120,
          );
          if (!locked) {
            throw new ConflictException('Concurrent post in progress — retry after a moment');
          }
        }

        const receipt = await this.findOne(wsId, firmId, id);
        if (receipt.state !== 'draft') {
          throw new BadRequestException(
            `Receipt is not in draft state (current: ${receipt.state})`,
          );
        }
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, receipt.receiptDate);

        const firm = await this.firmsService.findOne(wsId, firmId);
        const firmObj = {
          _id: firm._id,
          workspaceId: firm.workspaceId,
          gstin: (firm as any).gstin,
        };

        // Run inside a MongoDB transaction
        const conn = this.paymentReceiptModel.db;
        const result = await (conn as any).transaction(async (session: ClientSession) => {
          // FY is server-authoritative: derive from the receipt date so a back-dated
          // receipt is numbered into its true fiscal year (and honours the FY-lock).
          receipt.financialYear = this.voucherSeriesService.getFYForDate(
            receipt.receiptDate,
            (firm as any).fyStartMonth ?? 4,
          );
          // 1. Assign voucher number
          receipt.voucherNumber = await this.voucherSeriesService.generateNextNumber(
            firmId,
            'payment_in',
            receipt.financialYear,
          );

          // 2. Apply allocations (atomic $inc on invoices)
          // Returns the list of invoices whose amountDuePaise transitioned
          // from > 0 to <= 0 — used to emit `invoice.paid` party.timeline events
          // after the transaction commits (Phase 17 / FIN-16-03).
          const paidTransitions = await this.applyAllocations(
            wsId,
            firmId,
            receipt.allocations,
            session,
          );
          (receipt as any).__paidTransitions = paidTransitions;

          // 3. Post broker commission (if brokerPartyId set) — T-F03-04-07: atomic with receipt.save()
          if (receipt.brokerPartyId) {
            await this.brokerCommissionService.postCommission(receipt, { session, userId });
          }

          // 4. Post double-entry ledger
          await this.ledgerPostingService.postPaymentIn(receipt as any, {
            session,
            userId,
            firm: firmObj,
          });

          // 5. Update receipt state
          (receipt as any).state = 'posted';
          (receipt as any).postedAt = new Date();
          (receipt as any).postedBy = new Types.ObjectId(userId);
          (receipt.auditLog as any[]).push({
            at: new Date(),
            by: new Types.ObjectId(userId),
            action: 'posted',
          });

          return (receipt as any).save({ session });
        });

        // Store idempotency result
        if (idempotencyKey) {
          await this.idempotencyService.store(`post-receipt:${firmId}`, idempotencyKey, result);
        }

        // Phase 17 / FIN-16-03 — emit party.timeline AFTER commit (D-17 non-blocking).
        try {
          // payment.received — one event per receipt
          this.events.emit('party.timeline', {
            type: 'payment.received',
            workspaceId: wsId,
            firmId,
            partyId: result.partyId,
            refModel: 'PaymentReceipt',
            refId: result._id,
            occurredAt: result.receiptDate ?? new Date(),
            actorUserId: userId,
            summary: `Payment received via ${result.paymentMode}`,
            meta: {
              amountPaise: result.totalAmountPaise,
              mode: result.paymentMode,
            },
          });
          // invoice.paid — one event per invoice that transitioned due>0 → due<=0.
          const paidTransitions: Array<{
            invoiceId: Types.ObjectId | string;
            partyId: Types.ObjectId | string;
            voucherNumber?: string;
          }> = (receipt as any).__paidTransitions ?? [];
          for (const t of paidTransitions) {
            this.events.emit('party.timeline', {
              type: 'invoice.paid',
              workspaceId: wsId,
              firmId,
              partyId: t.partyId,
              refModel: 'SaleInvoice',
              refId: t.invoiceId,
              occurredAt: new Date(),
              actorUserId: userId,
              summary: `Invoice ${t.voucherNumber ?? ''} paid in full`.trim(),
              meta: { voucherNumber: t.voucherNumber },
            });
          }
        } catch (err) {
          this.logger.warn(
            `party.timeline emit failed for payment.received (id=${result._id}): ${(err as Error)?.message ?? String(err)}`,
          );
        }

        // Fire-and-forget product analytics on the successful post (ids/voucher no/amount only).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.posted_payment_receipt',
          properties: {
            workspaceId: wsId,
            firmId,
            receiptId: String(result._id),
            voucherNumber: result.voucherNumber,
            totalAmountPaise: result.totalAmountPaise,
            paymentMode: result.paymentMode,
          },
        });

        return result;
      },
    );
  }

  // ─── applyAllocations (private) ───────────────────────────────────────────

  private async applyAllocations(
    wsId: string,
    firmId: string,
    allocations: PaymentAllocation[],
    session: ClientSession,
  ): Promise<
    Array<{ invoiceId: Types.ObjectId; partyId: Types.ObjectId; voucherNumber?: string }>
  > {
    const paidTransitions: Array<{
      invoiceId: Types.ObjectId;
      partyId: Types.ObjectId;
      voucherNumber?: string;
    }> = [];
    for (const alloc of allocations) {
      // Re-validate inside transaction before $inc (T-F03-02-01, T-F03-02-04)
      const invoice = await this.saleInvoiceModel
        .findOne({
          _id: alloc.invoiceId,
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          isDeleted: false,
        })
        .session(session)
        .exec();

      if (!invoice) {
        throw new NotFoundException(`Invoice ${String(alloc.invoiceId)} not found during posting`);
      }
      if (alloc.allocatedPaise > invoice.amountDuePaise) {
        throw new BadRequestException(
          `Over-allocation: allocatedPaise=${alloc.allocatedPaise} > amountDuePaise=${invoice.amountDuePaise} for invoice ${invoice.voucherNumber ?? String(alloc.invoiceId)}`,
        );
      }

      // Atomic $inc — never read-then-write
      const updated = await this.saleInvoiceModel
        .findOneAndUpdate(
          {
            _id: alloc.invoiceId,
            workspaceId: new Types.ObjectId(wsId),
            firmId: new Types.ObjectId(firmId),
          },
          {
            $inc: { amountPaidPaise: alloc.allocatedPaise, amountDuePaise: -alloc.allocatedPaise },
          },
          { new: true, session },
        )
        .exec();

      if (updated) {
        // Compute paymentStatus after $inc
        let paymentStatus: string;
        if (updated.amountDuePaise <= 0) {
          paymentStatus = 'paid';
        } else if (updated.amountPaidPaise > 0) {
          paymentStatus = 'partial';
        } else if (updated.dueDate && updated.dueDate < new Date()) {
          paymentStatus = 'overdue';
        } else {
          paymentStatus = 'unpaid';
        }

        await this.saleInvoiceModel.updateOne(
          { _id: alloc.invoiceId },
          { $set: { paymentStatus } },
          { session },
        );

        // Phase 17 / FIN-16-03 — track invoice.paid transitions.
        // pre-allocation due was `invoice.amountDuePaise`; post-allocation
        // due is `updated.amountDuePaise`. Emit when pre>0 && post<=0.
        if (invoice.amountDuePaise > 0 && updated.amountDuePaise <= 0) {
          paidTransitions.push({
            invoiceId: alloc.invoiceId,
            partyId: (updated as any).partyId,
            voucherNumber: (updated as any).voucherNumber,
          });
        }
      }
    }
    return paidTransitions;
  }

  // ─── findInvoiceByCashfreeOrder ───────────────────────────────────────────

  async findInvoiceByCashfreeOrder(
    wsId: string,
    firmId: string,
    cashfreeOrderId: string,
  ): Promise<SaleInvoice | null> {
    return this.saleInvoiceModel
      .findOne({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        cashfreeOrderId,
      })
      .exec();
  }

  // ─── createFromWebhook ────────────────────────────────────────────────────
  // Called by Cashfree and Razorpay webhook handlers.
  // Accepts combined DTO with firmId embedded for the 2-arg calling convention used by webhooks.

  async createFromWebhook(
    wsId: string,
    webhookDto: CreatePaymentReceiptDto & {
      firmId: string;
      onlinePaymentId: string;
      autoReconciled?: boolean;
    },
  ): Promise<PaymentReceipt> {
    const { firmId, ...dto } = webhookDto;
    const systemUserId = '000000000000000000000000'; // system actor for webhooks
    const idempotencyKey = `webhook:${dto.onlinePaymentId}`;

    // Check cache first (idempotent: skip if already processed)
    const cached = await this.idempotencyService.getCached<PaymentReceipt>(
      `post-receipt:${firmId}`,
      idempotencyKey,
    );
    if (cached) return cached;

    // Create draft with autoReconciled flag
    const receiptDto: CreatePaymentReceiptDto = {
      ...dto,
      financialYear: dto.financialYear ?? new Date().getFullYear().toString(),
    };
    const receipt = await this.createDraft(wsId, firmId, receiptDto, systemUserId);
    const receiptId = receipt._id.toString();

    // Auto-post immediately
    return this.postPaymentReceipt(wsId, firmId, receiptId, systemUserId, idempotencyKey);
  }

  // ─── cancel ───────────────────────────────────────────────────────────────

  async cancel(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
    reason: string,
  ): Promise<PaymentReceipt> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelPaymentReceipt',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const receipt = await this.findOne(wsId, firmId, id);

        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, receipt.receiptDate);

        if (receipt.state === 'posted') {
          throw new BadRequestException(
            'Posted receipts cannot be cancelled directly. Reversal via Credit Note is handled in F-07.',
          );
        }
        if (receipt.state === 'cancelled') {
          throw new BadRequestException('Receipt is already cancelled');
        }

        (receipt as any).state = 'cancelled';
        (receipt.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'cancelled',
          reason,
        });

        const saved = await (receipt as any).save();
        // Fire-and-forget product analytics on the successful cancel (ids only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.cancelled_payment_receipt',
          properties: { workspaceId: wsId, firmId, receiptId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  // ─── findOne ──────────────────────────────────────────────────────────────

  async findOne(wsId: string, firmId: string, id: string): Promise<PaymentReceipt> {
    const doc = await this.paymentReceiptModel
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
    if (!doc) throw new NotFoundException('PaymentReceipt not found');
    return doc;
  }

  // ─── list ─────────────────────────────────────────────────────────────────

  async list(
    wsId: string,
    firmId: string,
    query: {
      partyId?: string;
      state?: string;
      dateFrom?: string;
      dateTo?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<PaymentReceipt[]> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };

    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.state) filter.state = query.state;
    if (query.dateFrom || query.dateTo) {
      filter.receiptDate = {};
      if (query.dateFrom) filter.receiptDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.receiptDate.$lte = new Date(query.dateTo);
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const skip = (page - 1) * limit;

    return this.paymentReceiptModel
      .find(filter)
      .sort({ receiptDate: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  }
}
