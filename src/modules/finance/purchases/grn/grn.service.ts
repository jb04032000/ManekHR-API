import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { GoodsReceiptNote } from './grn.schema';
import { CreateGrnDto } from './dto/create-grn.dto';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';

/**
 * GrnService — goods receipt note (NO ledger posting).
 * State machine: draft → received → cancelled
 *
 * Intentionally does NOT inject LedgerPostingService.
 * GRNs are warehouse receipts only; double-entry occurs at PurchaseBill post.
 */
@Injectable()
export class GrnService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(GoodsReceiptNote.name) private readonly model: Model<GoodsReceiptNote>,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly postHog: PostHogService,
  ) {}

  async createDraft(
    wsId: string,
    firmId: string,
    dto: CreateGrnDto,
    userId: string,
  ): Promise<GoodsReceiptNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.createGrn',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const doc = new this.model({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          voucherDate: dto.voucherDate,
          // FY is server-authoritative: derive from the voucher date (April-start, the
          // statutory Indian FY). Never trust a client-supplied financialYear.
          financialYear: this.voucherSeriesService.getFYForDate(new Date(dto.voucherDate)),
          partyId: dto.partyId ? new Types.ObjectId(dto.partyId) : undefined,
          partySnapshot: dto.partySnapshot ?? {},
          sourcePoId: dto.sourcePoId ? new Types.ObjectId(dto.sourcePoId) : undefined,
          sourcePoNumber: dto.sourcePoNumber,
          vendorDeliveryNoteNumber: dto.vendorDeliveryNoteNumber,
          vendorDeliveryNoteDate: dto.vendorDeliveryNoteDate,
          lineItems: dto.lineItems,
          notes: dto.notes,
          state: 'draft',
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
        });
        const saved = await doc.save();
        // Fire-and-forget product analytics on the successful draft write (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.created_grn',
          properties: { workspaceId: wsId, firmId, grnId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  /**
   * Confirm a GRN: assign voucherNumber and transition state to 'received'.
   * NO ledger posting — GRNs are financial-neutral.
   */
  async confirm(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<GoodsReceiptNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.confirmGrn',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const grn = await this.findOneOrThrow(wsId, firmId, id);
        if (grn.state !== 'draft') {
          throw new BadRequestException(`Cannot confirm GRN in state '${grn.state}'`);
        }
        // FY is server-authoritative: derive from the voucher date (statutory April FY).
        grn.financialYear = this.voucherSeriesService.getFYForDate(new Date(grn.voucherDate));
        grn.voucherNumber = await this.voucherSeriesService.generateNextNumber(
          firmId,
          'grn',
          grn.financialYear,
        );
        grn.state = 'received';
        grn.receivedBy = new Types.ObjectId(userId);
        grn.receivedAt = new Date();
        (grn.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'received',
        });
        const saved = await (grn as any).save();
        // Fire-and-forget product analytics on the successful confirm (ids / voucher no only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.received_grn',
          properties: {
            workspaceId: wsId,
            firmId,
            grnId: String(saved._id),
            voucherNumber: saved.voucherNumber,
          },
        });
        return saved;
      },
    );
  }

  async cancel(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
    reason?: string,
  ): Promise<GoodsReceiptNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelGrn',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const grn = await this.findOneOrThrow(wsId, firmId, id);
        if (grn.state === 'cancelled') {
          throw new BadRequestException('GRN is already cancelled');
        }
        grn.state = 'cancelled';
        (grn.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'cancelled',
          reason,
        });
        const saved = await (grn as any).save();
        // Fire-and-forget product analytics on the successful cancel (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.cancelled_grn',
          properties: { workspaceId: wsId, firmId, grnId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async findOne(wsId: string, firmId: string, id: string): Promise<GoodsReceiptNote | null> {
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
      sourcePoId?: string;
      dateFrom?: string | Date;
      dateTo?: string | Date;
      q?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<GoodsReceiptNote[]> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.state) filter.state = query.state;
    if (query.sourcePoId) filter.sourcePoId = new Types.ObjectId(query.sourcePoId);
    if (query.dateFrom || query.dateTo) {
      filter.voucherDate = {};
      if (query.dateFrom) filter.voucherDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.voucherDate.$lte = new Date(query.dateTo);
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
    return this.model.find(filter).sort({ voucherDate: -1 }).skip(skip).limit(limit).exec();
  }

  async updateDraft(
    wsId: string,
    firmId: string,
    id: string,
    dto: Partial<CreateGrnDto>,
    userId: string,
  ): Promise<GoodsReceiptNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateGrn',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const grn = await this.findOneOrThrow(wsId, firmId, id);
        if (grn.state !== 'draft') {
          throw new BadRequestException(`Cannot update GRN in state '${grn.state}'`);
        }
        // Whitelist allowed fields with explicit ObjectId conversion for reference fields (WR-01/WR-05)
        if (dto.voucherDate !== undefined) grn.voucherDate = dto.voucherDate;
        // FY is server-authoritative: always re-derive from the (possibly updated) voucher date.
        (grn as any).financialYear = this.voucherSeriesService.getFYForDate(
          new Date(grn.voucherDate),
        );
        if (dto.partyId !== undefined) (grn as any).partyId = new Types.ObjectId(dto.partyId);
        if (dto.partySnapshot !== undefined) (grn as any).partySnapshot = dto.partySnapshot;
        if (dto.sourcePoId !== undefined)
          (grn as any).sourcePoId = new Types.ObjectId(dto.sourcePoId);
        if (dto.sourcePoNumber !== undefined) (grn as any).sourcePoNumber = dto.sourcePoNumber;
        if (dto.vendorDeliveryNoteNumber !== undefined)
          (grn as any).vendorDeliveryNoteNumber = dto.vendorDeliveryNoteNumber;
        if (dto.vendorDeliveryNoteDate !== undefined)
          (grn as any).vendorDeliveryNoteDate = dto.vendorDeliveryNoteDate;
        if (dto.lineItems !== undefined) (grn as any).lineItems = dto.lineItems;
        if (dto.notes !== undefined) (grn as any).notes = dto.notes;
        (grn.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'updated',
        });
        const saved = await (grn as any).save();
        // Fire-and-forget product analytics on the successful draft update (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.updated_grn',
          properties: { workspaceId: wsId, firmId, grnId: String(saved._id) },
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
  ): Promise<GoodsReceiptNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.deleteGrn',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const grn = await this.findOneOrThrow(wsId, firmId, id);
        if (grn.state === 'received') {
          throw new BadRequestException('Received GRNs cannot be deleted');
        }
        (grn as any).isDeleted = true;
        (grn as any).deletedAt = new Date();
        (grn.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'deleted',
        });
        const saved = await (grn as any).save();
        // Fire-and-forget product analytics on the successful soft-delete (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.deleted_grn',
          properties: { workspaceId: wsId, firmId, grnId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  private async findOneOrThrow(
    wsId: string,
    firmId: string,
    id: string,
  ): Promise<GoodsReceiptNote> {
    const doc = await this.findOne(wsId, firmId, id);
    if (!doc) throw new NotFoundException('GRN not found');
    return doc;
  }
}
