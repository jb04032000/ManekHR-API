import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { ClientSession, Document, Model, Types } from 'mongoose';
import { PurchaseBill } from './purchase-bill.schema';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';
import { supplierCreditorBasePaise } from './purchase-bill-rcm.rules';
import { TdsService } from '../tds/tds.service';
import { CapitalGoodsItcService } from '../capital-goods-itc/capital-goods-itc.service';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { IdempotencyService } from '../../sales/common/idempotency.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { FirmsService } from '../../firms/firms.service';
import { PartiesService } from '../../parties/parties.service';
import { CreatePurchaseBillDto } from './dto/create-purchase-bill.dto';
import { StockMovementsService } from '../../inventory/stock-movements/stock-movements.service';
import { LotsService } from '../../inventory/lots/lots.service';
import { Item } from '../../items/item.schema';
import { FyLockService } from '../../fiscal-year/fy-lock.service';

type ItemDocument = Item & Document;

/**
 * PurchaseBillService — buy-side bill lifecycle.
 * State machine: draft → posted → (cancelled only from draft)
 *
 * post() runs inside a MongoDB transaction:
 *   1. Assign voucherNumber via VoucherSeries
 *   2. Determine isIntraState from placeOfSupply comparison
 *   3. Compute TDS-194Q via TdsService (race-safe $inc)
 *   4. Set netPayableToCreditorsAfterTdsPaise
 *   5. Start MSME 45-day clock if vendor.msmeRegistration.isUdyamRegistered
 *   6. Post double-entry via LedgerPostingService.postPurchaseBill
 *   7. Create capital-goods ITC schedules via CapitalGoodsItcService
 *   8. F-09 Gap 8: stock inward + lot auto-creation per line
 *   9. Set state='posted', save
 */
@Injectable()
export class PurchaseBillService {
  private readonly logger = new Logger(PurchaseBillService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Spans wrap each write; PostHog fires fire-and-forget after a successful write.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(PurchaseBill.name) private readonly model: Model<PurchaseBill>,
    @InjectModel(Item.name) private readonly itemModel: Model<ItemDocument>,
    private readonly tdsService: TdsService,
    private readonly capitalGoodsItcService: CapitalGoodsItcService,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly idempotencyService: IdempotencyService,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly firmsService: FirmsService,
    private readonly partiesService: PartiesService,
    private readonly stockMovementsService: StockMovementsService,
    private readonly lotsService: LotsService,
    private readonly fyLock: FyLockService,
    private readonly postHog: PostHogService,
  ) {}

  async createDraft(
    wsId: string,
    firmId: string,
    dto: CreatePurchaseBillDto,
    userId: string,
  ): Promise<PurchaseBill> {
    return withFinanceSpan(
      this.tracer,
      'finance.createPurchaseBill',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // F-15 Plan 03: FY-lock guard (D-16, D-44)
        await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate));

        if (!dto.lineItems || dto.lineItems.length === 0) {
          throw new BadRequestException('At least one line item is required');
        }
        const doc = new this.model({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          voucherDate: dto.voucherDate,
          // FY is server-authoritative: derive from the bill's voucher date (post()
          // re-derives with the firm's fyStartMonth). Never trust the client value.
          financialYear: this.voucherSeriesService.getFYForDate(new Date(dto.voucherDate)),
          partyId: dto.partyId ? new Types.ObjectId(dto.partyId) : undefined,
          partySnapshot: dto.partySnapshot ?? {},
          placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
          isReverseCharge: dto.isReverseCharge ?? false,
          vendorBillNumber: dto.vendorBillNumber,
          vendorBillDate: dto.vendorBillDate,
          sourcePoId: dto.sourcePoId ? new Types.ObjectId(dto.sourcePoId) : undefined,
          sourcePoNumber: dto.sourcePoNumber,
          sourceGrnId: dto.sourceGrnId ? new Types.ObjectId(dto.sourceGrnId) : undefined,
          sourceGrnNumber: dto.sourceGrnNumber,
          lineItems: dto.lineItems,
          taxableValuePaise: dto.taxableValuePaise,
          cgstPaise: dto.cgstPaise ?? 0,
          sgstPaise: dto.sgstPaise ?? 0,
          igstPaise: dto.igstPaise ?? 0,
          grandTotalPaise: dto.grandTotalPaise,
          ocrSourceFileUrl: dto.ocrSourceFileUrl,
          ocrConfidence: dto.ocrConfidence,
          state: 'draft',
          paymentStatus: 'unpaid',
          amountPaidPaise: 0,
          amountDuePaise: 0,
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
        });
        const saved = await doc.save();
        // Fire-and-forget product analytics on the successful draft write (ids only, no PII).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.created_purchase_bill',
          properties: { workspaceId: wsId, firmId, purchaseBillId: String(saved._id) },
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
    // Finance/Bills hardening (OQ-FB-5): when the caller is exempt from the
    // maker-checker / four-eyes block (Owner or HR), the self-post guard below
    // is skipped. Resolved at the controller (owner short-circuit + HR-tier
    // grant check) and passed in. Defaults true so non-controller callers (none
    // today) and the existing tests are unchanged.
    isExemptFromMakerChecker = true,
  ): Promise<PurchaseBill> {
    return withFinanceSpan(
      this.tracer,
      'finance.postPurchaseBill',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // Idempotency: return cached result if same key was already posted
        if (idempotencyKey) {
          const cached = await this.idempotencyService.getCached<PurchaseBill>(
            `post-pb:${firmId}`,
            idempotencyKey,
          );
          if (cached) return cached;
          const acquired = await this.idempotencyService.tryAcquireLock(
            `post-pb:${firmId}`,
            idempotencyKey,
            120,
          );
          if (!acquired)
            throw new BadRequestException('Concurrent post in progress — retry after a moment');
        }

        const bill = await this.findOne(wsId, firmId, id);
        if (!bill) throw new NotFoundException('Purchase Bill not found');
        if (bill.state !== 'draft') {
          throw new BadRequestException(`Cannot post bill in state '${bill.state}'`);
        }

        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, bill.voucherDate);

        const firm = await this.firmsService.findOne(wsId, firmId);
        if (!firm) throw new NotFoundException('Firm not found');

        // Finance/Bills hardening (OQ-FB-5) — maker-checker / four-eyes block for
        // PurchaseBill posting, DEFAULT OFF (firm.makerCheckerEnabled.purchase_bill
        // is false by default). When a workspace turns it ON, a Manager cannot
        // post a bill they themselves drafted: the bill's first auditLog entry's
        // `by` is the creator, and if that equals the poster the post is blocked.
        // Owner / HR are exempt (isExemptFromMakerChecker, resolved at the
        // controller). This is the four-eyes principle for AP internal control —
        // the creator and the poster must be different people. Fully enforced when
        // ON; a no-op when OFF (the shipped default).
        if (
          (firm as any).makerCheckerEnabled?.purchase_bill === true &&
          !isExemptFromMakerChecker
        ) {
          const creatorId = (bill.auditLog as any[])?.[0]?.by
            ? String((bill.auditLog as any[])[0].by)
            : undefined;
          if (creatorId && creatorId === String(userId)) {
            throw new BadRequestException({
              code: 'MAKER_CHECKER_SELF_POST_BLOCKED',
              message:
                'Four-eyes control is on for purchase bills: you cannot post a bill you created. Ask a different approver (or HR/Owner) to post it.',
            });
          }
        }

        // FY is server-authoritative: derive from the bill's voucher date so a
        // back-dated bill is numbered into its true fiscal year (and honours the FY-lock).
        bill.financialYear = this.voucherSeriesService.getFYForDate(
          bill.voucherDate,
          (firm as any).fyStartMonth ?? 4,
        );
        const party = bill.partyId
          ? await this.partiesService.findOne(wsId, firmId, bill.partyId.toString())
          : null;

        const conn = this.model.db;
        // R10: D23 quarantine — wrap the transaction so a post failure (after the ledger write
        // rolls back, leaving the bill draft) flags the bill 'needs_attention' in a SEPARATE
        // write OUTSIDE the aborted transaction, so it isn't itself rolled back. Mirrors SaleInvoice.
        let result: any;
        try {
          result = await (conn as any).transaction(async (session: ClientSession) => {
            // 1. Assign voucher number
            bill.voucherNumber = await this.voucherSeriesService.generateNextNumber(
              firmId,
              'purchase_bill',
              bill.financialYear,
            );

            // 1b. RCM self-invoice (Sec 31(3)(f) / Rule 47A): a registered recipient must
            // self-invoice for supplies received from an unregistered supplier. Issued
            // within 30 days of receipt of supply (Rule 47A, effective 1-Nov-2024).
            const supplierGstin = (party as any)?.gstin || (bill.partySnapshot as any)?.gstin;
            if (bill.isReverseCharge && !supplierGstin) {
              const selfInvoiceNumber = await this.voucherSeriesService.generateNextNumber(
                firmId,
                'rcm_self_invoice',
                bill.financialYear,
              );
              const issueDate = new Date(bill.voucherDate);
              const dueDate = new Date(issueDate);
              dueDate.setDate(dueDate.getDate() + 30);
              bill.rcmSelfInvoice = { number: selfInvoiceNumber, date: issueDate, dueDate };
            }

            // 2. Determine intra-state vs inter-state for ITC routing
            const firmStateCode = (firm as any).placeOfSupplyStateCode || (firm as any).stateCode;
            const partyStateCode =
              bill.placeOfSupplyStateCode || (bill.partySnapshot as any)?.placeOfSupplyStateCode;
            const isIntraState =
              firmStateCode && partyStateCode ? firmStateCode === partyStateCode : true;

            // 3. Compute TDS-194Q at post time (ONLY here, never at draft create — T-F04-02-02)
            const tds194Q = await this.tdsService.compute194Q(
              {
                workspaceId: bill.workspaceId,
                firmId: bill.firmId,
                partyId: bill.partyId,
                taxableValuePaise: bill.taxableValuePaise,
                financialYear: bill.financialYear,
              },
              { pan: (party as any)?.pan },
              { aato: (firm as any).aato },
              session,
            );

            if (tds194Q) bill.tds194Q = tds194Q;
            // Under reverse charge the supplier is not paid the tax (the recipient
            // self-pays it to the government via the output-tax liability posted in the
            // ledger), so the creditor is owed only the taxable value, not the grand total.
            bill.netPayableToCreditorsAfterTdsPaise =
              supplierCreditorBasePaise(bill) - (tds194Q?.tdsPaise ?? 0);
            bill.amountDuePaise = bill.netPayableToCreditorsAfterTdsPaise;
            bill.amountPaidPaise = 0;
            bill.paymentStatus = 'unpaid';

            // 4. MSME 45-day clock (Sec 43B(h)) — starts at bill post
            if ((party as any)?.msmeRegistration?.isUdyamRegistered) {
              bill.msmeApplicable = true;
              const deadline = new Date(bill.voucherDate);
              deadline.setDate(deadline.getDate() + 45);
              bill.msmePaymentDeadline = deadline;
            }

            // 5. Double-entry ledger posting (Dr Purchases Dr ITC Cr Creditors Cr TDS)
            await this.ledgerPostingService.postPurchaseBill(bill, {
              session,
              userId,
              firm: firm,
              isIntraState,
            });

            // 6. Create capital-goods ITC schedules (deferred to 1103, released over 60 months)
            await this.capitalGoodsItcService.createScheduleForBill(bill, session);

            // 7. F-09 Gap 8: stock inward + lot auto-creation per line
            for (const line of (bill as any).lineItems ?? []) {
              const item = await this.itemModel.findById(line.itemId).lean();
              if (!item || (item as any).trackStock === false) continue;

              // Resolve godown: use line.godownId or fall back to firm's default godown
              const godownId: string = line.godownId
                ? line.godownId.toString()
                : ((await this.firmsService.getDefaultGodownId(bill.firmId))?.toString() ?? '');

              if (!godownId) {
                this.logger.warn(
                  `No godown resolved for item ${String(line.itemId)} in firm ${String(bill.firmId)}; skipping stock movement`,
                );
                continue;
              }

              // Lot auto-create: if item.trackBatch === true and no existing lotId on the line
              let lotId: string | undefined = line.lotId?.toString();
              if ((item as any).trackBatch === true && !lotId) {
                const newLot = await this.lotsService.create(
                  (bill as any).workspaceId.toString(),
                  bill.firmId.toString(),
                  {
                    itemId: line.itemId.toString(),
                    qtyInward: line.qty ?? line.quantity ?? 0,
                    godownId,
                    inwardDate:
                      bill.voucherDate instanceof Date
                        ? bill.voucherDate.toISOString()
                        : new Date().toISOString(),
                    supplierId: bill.partyId?.toString(),
                    sourceVoucherId: (bill as any)._id.toString(),
                    sourceVoucherType: 'purchase_bill',
                    expiryDate: line.expiryDate,
                    mfgDate: line.mfgDate,
                  },
                );
                lotId = (newLot as any)._id.toString();
                line.lotId = new Types.ObjectId(lotId);
              }

              // Stock inward: record purchase_in movement
              await this.stockMovementsService.record(
                {
                  workspaceId: (bill as any).workspaceId.toString(),
                  firmId: bill.firmId.toString(),
                  movementType: 'purchase_in',
                  itemId: line.itemId.toString(),
                  godownId,
                  lotId,
                  batchId: line.batchId?.toString(),
                  serialNos: line.serialNos,
                  qty: Math.abs(line.qty ?? line.quantity ?? 0),
                  costPaise: line.ratePaise ?? line.purchaseRatePaise ?? 0,
                  sourceVoucherId: (bill as any)._id.toString(),
                  sourceVoucherType: 'purchase_bill',
                  sourceVoucherNumber: (bill as any).voucherNumber ?? (bill as any).billNumber,
                },
                userId,
                session,
              );
            }

            // 8. Mark posted
            bill.state = 'posted';
            // R10: clear the D23 quarantine flag on a successful post (mirrors SaleInvoice).
            bill.postingStatus = undefined;
            bill.postedBy = new Types.ObjectId(userId);
            bill.postedAt = new Date();
            (bill.auditLog as any[]).push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'posted',
            });

            return (bill as any).save({ session });
          });
        } catch (err) {
          // R10: best-effort quarantine outside the (aborted) transaction, then rethrow.
          await this.model
            .updateOne(
              { _id: new Types.ObjectId(id) },
              { $set: { postingStatus: 'needs_attention' } },
            )
            .catch(() => undefined);
          throw err;
        }

        if (idempotencyKey) {
          await this.idempotencyService.store(`post-pb:${firmId}`, idempotencyKey, result);
        }
        // Fire-and-forget product analytics on the successful post (ids / voucher no only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.posted_purchase_bill',
          properties: {
            workspaceId: wsId,
            firmId,
            purchaseBillId: String(result._id),
            voucherNumber: result.voucherNumber,
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
  ): Promise<PurchaseBill> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelPurchaseBill',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const bill = await this.findOne(wsId, firmId, id);
        if (!bill) throw new NotFoundException('Purchase Bill not found');
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, bill.voucherDate);
        if (bill.state === 'posted') {
          throw new BadRequestException(
            'Posted purchase bills cannot be cancelled directly. Reversal is handled in F-07.',
          );
        }
        if (bill.state === 'cancelled') {
          throw new BadRequestException('Purchase Bill is already cancelled');
        }
        bill.state = 'cancelled';
        (bill.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'cancelled',
          reason,
        });
        const saved = await (bill as any).save();
        // Fire-and-forget product analytics on the successful cancel (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.cancelled_purchase_bill',
          properties: { workspaceId: wsId, firmId, purchaseBillId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async updateDraft(
    wsId: string,
    firmId: string,
    id: string,
    dto: Partial<CreatePurchaseBillDto>,
    userId: string,
  ): Promise<PurchaseBill> {
    return withFinanceSpan(
      this.tracer,
      'finance.updatePurchaseBill',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const bill = await this.findOne(wsId, firmId, id);
        if (!bill) throw new NotFoundException('Purchase Bill not found');
        if (bill.state !== 'draft') {
          throw new BadRequestException(`Cannot update bill in state '${bill.state}'`);
        }
        // F-15 Plan 03: FY-lock guard against BOTH old and new voucherDate
        await this.fyLock.assertOpen(wsId, firmId, bill.voucherDate);
        if (dto.voucherDate) {
          await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate));
        }
        // Whitelist allowed fields — prevents client injecting state/workspaceId/firmId/amountDuePaise
        const allowed: (keyof CreatePurchaseBillDto)[] = [
          'voucherDate',
          'financialYear',
          'partyId',
          'partySnapshot',
          'placeOfSupplyStateCode',
          'vendorBillNumber',
          'vendorBillDate',
          'sourcePoId',
          'sourcePoNumber',
          'sourceGrnId',
          'sourceGrnNumber',
          'lineItems',
          'taxableValuePaise',
          'cgstPaise',
          'sgstPaise',
          'igstPaise',
          'grandTotalPaise',
          'ocrSourceFileUrl',
          'ocrConfidence',
        ];
        for (const key of allowed) {
          if (key in dto) (bill as any)[key] = (dto as any)[key];
        }
        (bill.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'updated',
        });
        const saved = await (bill as any).save();
        // Fire-and-forget product analytics on the successful draft update (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.updated_purchase_bill',
          properties: { workspaceId: wsId, firmId, purchaseBillId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async softDelete(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<PurchaseBill> {
    return withFinanceSpan(
      this.tracer,
      'finance.deletePurchaseBill',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const bill = await this.findOne(wsId, firmId, id);
        if (!bill) throw new NotFoundException('Purchase Bill not found');
        if (bill.state === 'posted') {
          throw new BadRequestException('Posted purchase bills cannot be deleted');
        }
        (bill as any).isDeleted = true;
        (bill as any).deletedAt = new Date();
        (bill.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'deleted',
        });
        const saved = await (bill as any).save();
        // Fire-and-forget product analytics on the successful soft-delete (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.deleted_purchase_bill',
          properties: { workspaceId: wsId, firmId, purchaseBillId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async findOne(wsId: string, firmId: string, id: string): Promise<PurchaseBill | null> {
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
      paymentStatus?: string | string[];
      // R10: D23 quarantine filter — 'needs_attention' | 'clean' (mirrors SaleInvoice.list).
      postingStatus?: string;
      dateFrom?: Date;
      dateTo?: Date;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<PurchaseBill[]> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.state) filter.state = query.state;
    if (query.paymentStatus) {
      // Accept array or comma-separated string (e.g. "unpaid,partial,overdue" from frontend)
      const statuses = Array.isArray(query.paymentStatus)
        ? query.paymentStatus
        : query.paymentStatus.split(',');
      filter.paymentStatus = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }
    // R10: D23 quarantine filter (mirrors SaleInvoice.list two-branch logic).
    if (query.postingStatus === 'needs_attention') filter.postingStatus = 'needs_attention';
    else if (query.postingStatus === 'clean') filter.postingStatus = { $exists: false };
    if (query.dateFrom || query.dateTo) {
      filter.voucherDate = {};
      if (query.dateFrom) filter.voucherDate.$gte = query.dateFrom;
      if (query.dateTo) filter.voucherDate.$lte = query.dateTo;
    }
    const limit = query.limit ?? 50;
    const skip = ((query.page ?? 1) - 1) * limit;
    return this.model.find(filter).sort({ voucherDate: -1 }).skip(skip).limit(limit).exec();
  }
}
