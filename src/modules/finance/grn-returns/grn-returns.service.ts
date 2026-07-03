import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Connection, Types } from 'mongoose';
import { GrnReturn } from './grn-return.schema';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../common/finance-observability';
import { GoodsReceiptNote } from '../purchases/grn/grn.schema';
import { PurchaseBill } from '../purchases/purchase-bill/purchase-bill.schema';
import { InventoryService } from '../sales/inventory/inventory.service';
import { VoucherSeriesService } from '../voucher-series/voucher-series.service';
import { CreateGrnReturnDto, UpdateGrnReturnDto, ListGrnReturnsQueryDto } from './grn-return.dto';
import { FyLockService } from '../fiscal-year/fy-lock.service';

// CRITICAL: This service does NOT inject LedgerPostingService.
// GRN-Return is financial-neutral by design — mirrors grn.service.ts comment line 11:
// "Intentionally does NOT inject LedgerPostingService. GRNs are warehouse receipts only"

@Injectable()
export class GrnReturnsService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(GrnReturn.name) private readonly grnReturnModel: Model<GrnReturn>,
    @InjectModel(GoodsReceiptNote.name)
    private readonly grnModel: Model<GoodsReceiptNote>,
    @InjectModel(PurchaseBill.name)
    private readonly purchaseBillModel: Model<PurchaseBill>,
    @InjectConnection() private readonly connection: Connection,
    private readonly inventoryService: InventoryService,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly fyLock: FyLockService,
    private readonly postHog: PostHogService,
  ) {}

  // ─── Private helper: derive financial year from voucherDate ─────────────────
  private getFinancialYear(date: Date): string {
    const month = date.getUTCMonth() + 1; // 1-12
    const year = date.getUTCFullYear();
    const startYear = month >= 4 ? year : year - 1;
    return `${startYear}-${String(startYear + 1).slice(-2)}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // createDraft
  // ═══════════════════════════════════════════════════════════════════════════
  async createDraft(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    dto: CreateGrnReturnDto,
    userId: string,
  ): Promise<GrnReturn> {
    return withFinanceSpan(
      this.tracer,
      'finance.createGrnReturn',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(workspaceId, firmId, new Date(dto.voucherDate));

        let partyId: Types.ObjectId | undefined;
        let partySnapshot: any = {};
        let sourceGrnNumber: string | undefined;
        let sourceBillNumber: string | undefined;

        if (dto.sourceGrnId) {
          const sourceGrn = await this.grnModel
            .findOne({
              _id: new Types.ObjectId(dto.sourceGrnId),
              workspaceId,
              firmId,
              isDeleted: { $ne: true },
            })
            .lean();
          if (!sourceGrn) throw new NotFoundException('Source GRN not found');
          partyId = (sourceGrn as any).partyId;
          partySnapshot = (sourceGrn as any).partySnapshot ?? {};
          sourceGrnNumber = (sourceGrn as any).voucherNumber;
        }

        if (dto.sourceBillId) {
          const sourceBill = await this.purchaseBillModel
            .findOne({
              _id: new Types.ObjectId(dto.sourceBillId),
              workspaceId,
              firmId,
              isDeleted: { $ne: true },
            })
            .lean();
          if (!sourceBill) throw new NotFoundException('Source bill not found');
          partyId = partyId ?? (sourceBill as any).partyId;
          partySnapshot =
            Object.keys(partySnapshot).length === 0
              ? ((sourceBill as any).partySnapshot ?? {})
              : partySnapshot;
          sourceBillNumber = (sourceBill as any).voucherNumber;
        }

        if (!partyId && dto.partyId) {
          partyId = new Types.ObjectId(dto.partyId);
        }

        const voucherDate = new Date(dto.voucherDate);

        const grnReturn = new this.grnReturnModel({
          workspaceId,
          firmId,
          voucherType: 'grn_return',
          voucherDate,
          financialYear: this.getFinancialYear(voucherDate),
          state: 'draft',
          sourceGrnId: dto.sourceGrnId ? new Types.ObjectId(dto.sourceGrnId) : undefined,
          sourceGrnNumber,
          sourceBillId: dto.sourceBillId ? new Types.ObjectId(dto.sourceBillId) : undefined,
          sourceBillNumber,
          partyId,
          partySnapshot,
          vendorRmaNumber: dto.vendorRmaNumber,
          transport: dto.transport
            ? {
                carrier: dto.transport.carrier,
                lrNumber: dto.transport.lrNumber,
                dispatchDate: dto.transport.dispatchDate
                  ? new Date(dto.transport.dispatchDate)
                  : undefined,
              }
            : undefined,
          lineItems: dto.lineItems.map((l) => ({
            itemId: l.itemId ? new Types.ObjectId(l.itemId) : undefined,
            itemName: l.itemName,
            qtyReturned: l.qtyReturned,
            unit: l.unit,
            ratePaise: l.ratePaise,
            reason: l.reason,
            batchNumber: l.batchNumber,
            notes: l.notes,
          })),
          notes: dto.notes,
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'create_draft' }],
        });

        await grnReturn.save();
        // Fire-and-forget product analytics on the successful draft write (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.created_grn_return',
          properties: {
            workspaceId: workspaceId.toString(),
            firmId: firmId.toString(),
            grnReturnId: String(grnReturn._id),
          },
        });
        return grnReturn;
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // update (draft only)
  // ═══════════════════════════════════════════════════════════════════════════
  async update(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    dto: UpdateGrnReturnDto,
    userId: string,
  ): Promise<GrnReturn> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateGrnReturn',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const gr = await this.grnReturnModel.findOne({
          _id: new Types.ObjectId(id),
          workspaceId,
          firmId,
        });
        if (!gr) throw new NotFoundException('GRN-Return not found');
        if (gr.state !== 'draft') {
          throw new BadRequestException('Only draft GRN-Returns can be updated');
        }
        // F-15 Plan 03: FY-lock guard against BOTH old and new voucherDate
        await this.fyLock.assertOpen(workspaceId, firmId, gr.voucherDate);
        if ((dto as any).voucherDate) {
          await this.fyLock.assertOpen(workspaceId, firmId, new Date((dto as any).voucherDate));
        }

        if (dto.voucherDate) {
          gr.voucherDate = new Date(dto.voucherDate);
          gr.financialYear = this.getFinancialYear(gr.voucherDate);
        }
        if (dto.vendorRmaNumber !== undefined) gr.vendorRmaNumber = dto.vendorRmaNumber;
        if (dto.transport) {
          gr.transport = {
            carrier: dto.transport.carrier,
            lrNumber: dto.transport.lrNumber,
            dispatchDate: dto.transport.dispatchDate
              ? new Date(dto.transport.dispatchDate)
              : undefined,
          };
        }
        if (dto.lineItems) {
          gr.lineItems = dto.lineItems.map((l) => ({
            itemId: l.itemId ? new Types.ObjectId(l.itemId) : undefined,
            itemName: l.itemName,
            qtyReturned: l.qtyReturned,
            unit: l.unit,
            ratePaise: l.ratePaise,
            reason: l.reason,
            batchNumber: l.batchNumber,
            notes: l.notes,
          })) as any;
        }
        if (dto.notes !== undefined) gr.notes = dto.notes;

        gr.auditLog.push({ at: new Date(), by: new Types.ObjectId(userId), action: 'update' });
        await gr.save();
        // Fire-and-forget product analytics on the successful draft update (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.updated_grn_return',
          properties: {
            workspaceId: workspaceId.toString(),
            firmId: firmId.toString(),
            grnReturnId: String(gr._id),
          },
        });
        return gr;
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // dispatch (draft → dispatched; assigns voucherNumber; calls stockOut)
  // ═══════════════════════════════════════════════════════════════════════════
  async dispatch(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    userId: string,
  ): Promise<GrnReturn> {
    return withFinanceSpan(
      this.tracer,
      'finance.dispatchGrnReturn',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const gr = await this.grnReturnModel.findOne({
          _id: new Types.ObjectId(id),
          workspaceId,
          firmId,
        });
        if (!gr) throw new NotFoundException('GRN-Return not found');
        if (gr.state !== 'draft') {
          throw new BadRequestException('Only draft GRN-Returns can be dispatched');
        }
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(workspaceId, firmId, gr.voucherDate);

        const session = await this.connection.startSession();
        try {
          await session.withTransaction(async () => {
            // Assign voucher number on dispatch (first state where it becomes "real")
            gr.voucherNumber = await this.voucherSeriesService.generateNextNumber(
              firmId.toString(),
              'grn_return',
              gr.financialYear,
            );

            // Reduce stock (Pitfall 6 — InventoryService allows negative; warns but does NOT block)
            const stockLines = gr.lineItems
              .filter((l: any) => l.itemId && l.qtyReturned && l.qtyReturned > 0)
              .map((l: any) => ({ itemId: l.itemId, qty: l.qtyReturned }));
            if (stockLines.length > 0) {
              await this.inventoryService.stockOut(
                workspaceId.toString(),
                firmId.toString(),
                stockLines,
                { session },
              );
            }

            gr.state = 'dispatched';
            gr.dispatchedBy = new Types.ObjectId(userId);
            gr.dispatchedAt = new Date();
            gr.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'dispatch',
              after: { voucherNumber: gr.voucherNumber },
            });
            await gr.save({ session });
          });
          // Fire-and-forget product analytics on the successful dispatch (ids / voucher no only).
          this.postHog?.capture({
            distinctId: userId,
            event: 'purchases.dispatched_grn_return',
            properties: {
              workspaceId: workspaceId.toString(),
              firmId: firmId.toString(),
              grnReturnId: String(gr._id),
              voucherNumber: gr.voucherNumber,
            },
          });
          return gr;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // confirm (dispatched → confirmed; returns promptCreateDebitNote flag)
  // ═══════════════════════════════════════════════════════════════════════════
  async confirm(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    userId: string,
  ): Promise<{ grnReturn: GrnReturn; promptCreateDebitNote: boolean }> {
    return withFinanceSpan(
      this.tracer,
      'finance.confirmGrnReturn',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const gr = await this.grnReturnModel.findOne({
          _id: new Types.ObjectId(id),
          workspaceId,
          firmId,
        });
        if (!gr) throw new NotFoundException('GRN-Return not found');
        if (gr.state !== 'dispatched') {
          throw new BadRequestException('Only dispatched GRN-Returns can be confirmed');
        }
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(workspaceId, firmId, gr.voucherDate);

        gr.state = 'confirmed';
        gr.confirmedBy = new Types.ObjectId(userId);
        gr.confirmedAt = new Date();
        gr.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'confirm',
        });
        await gr.save();

        // Fire-and-forget product analytics on the successful confirm (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.confirmed_grn_return',
          properties: {
            workspaceId: workspaceId.toString(),
            firmId: firmId.toString(),
            grnReturnId: String(gr._id),
          },
        });
        // Prompt UI to create a Debit Note if none is linked yet
        return { grnReturn: gr, promptCreateDebitNote: !gr.linkedDebitNoteId };
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // cancel (any non-cancelled state → cancelled; restores stock if dispatched/confirmed)
  // ═══════════════════════════════════════════════════════════════════════════
  async cancel(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    reason: string,
    userId: string,
  ): Promise<GrnReturn> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelGrnReturn',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const gr = await this.grnReturnModel.findOne({
          _id: new Types.ObjectId(id),
          workspaceId,
          firmId,
        });
        if (!gr) throw new NotFoundException('GRN-Return not found');
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(workspaceId, firmId, gr.voucherDate);
        if (gr.state === 'cancelled') {
          throw new BadRequestException('GRN-Return already cancelled');
        }

        // Stock was reduced at dispatch; restore on cancel if state was dispatched OR confirmed (Edge Case 6)
        const wasStockReduced = gr.state === 'dispatched' || gr.state === 'confirmed';

        const session = await this.connection.startSession();
        try {
          await session.withTransaction(async () => {
            if (wasStockReduced) {
              const stockLines = gr.lineItems
                .filter((l: any) => l.itemId && l.qtyReturned && l.qtyReturned > 0)
                .map((l: any) => ({ itemId: l.itemId, qty: l.qtyReturned }));
              if (stockLines.length > 0) {
                await this.inventoryService.stockIn(
                  workspaceId.toString(),
                  firmId.toString(),
                  stockLines,
                  { session },
                );
              }
            }

            gr.state = 'cancelled';
            gr.cancelledBy = new Types.ObjectId(userId);
            gr.cancelledAt = new Date();
            gr.cancellationReason = reason;
            gr.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'cancel',
              reason,
              before: { stockRestored: wasStockReduced },
            });
            await gr.save({ session });
          });
          // Fire-and-forget product analytics on the successful cancel (ids only).
          this.postHog?.capture({
            distinctId: userId,
            event: 'purchases.cancelled_grn_return',
            properties: {
              workspaceId: workspaceId.toString(),
              firmId: firmId.toString(),
              grnReturnId: String(gr._id),
            },
          });
          return gr;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // findAll
  // ═══════════════════════════════════════════════════════════════════════════
  async findAll(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    query: ListGrnReturnsQueryDto,
  ): Promise<{ items: GrnReturn[]; total: number }> {
    const filter: any = { workspaceId, firmId, isDeleted: { $ne: true } };
    if (query.state) filter.state = query.state;
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.fromDate || query.toDate) {
      filter.voucherDate = {};
      if (query.fromDate) filter.voucherDate.$gte = new Date(query.fromDate);
      if (query.toDate) filter.voucherDate.$lte = new Date(query.toDate);
    }
    const limit = Math.min(query.limit ?? 50, 200);
    const skip = query.skip ?? 0;
    const [items, total] = await Promise.all([
      this.grnReturnModel.find(filter).sort({ voucherDate: -1 }).skip(skip).limit(limit).lean(),
      this.grnReturnModel.countDocuments(filter),
    ]);
    return { items: items as any, total };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // findById
  // ═══════════════════════════════════════════════════════════════════════════
  async findById(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
  ): Promise<GrnReturn> {
    const gr = await this.grnReturnModel
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId,
        firmId,
        isDeleted: { $ne: true },
      })
      .lean();
    if (!gr) throw new NotFoundException('GRN-Return not found');
    return gr as any;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // linkDebitNote (called by DebitNotesService after DN is posted against a GRN-Return)
  // ═══════════════════════════════════════════════════════════════════════════
  async linkDebitNote(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    debitNoteId: Types.ObjectId,
    debitNoteNumber: string,
  ): Promise<void> {
    await this.grnReturnModel.updateOne(
      { _id: new Types.ObjectId(id), workspaceId, firmId },
      {
        $set: {
          linkedDebitNoteId: debitNoteId,
          linkedDebitNoteNumber: debitNoteNumber,
        },
      },
    );
  }
}
