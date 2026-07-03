import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { PurchaseOrder } from './purchase-order.schema';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';

/**
 * PurchaseOrderService — procurement document (NO ledger posting).
 * State machine: draft → confirmed → cancelled
 *
 * Intentionally does NOT inject LedgerPostingService.
 * POs are procurement intent only; double-entry occurs at PurchaseBill post.
 */
@Injectable()
export class PurchaseOrderService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(PurchaseOrder.name) private readonly model: Model<PurchaseOrder>,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly postHog: PostHogService,
  ) {}

  async createDraft(
    wsId: string,
    firmId: string,
    dto: CreatePurchaseOrderDto,
    userId: string,
  ): Promise<PurchaseOrder> {
    return withFinanceSpan(
      this.tracer,
      'finance.createPurchaseOrder',
      { workspaceId: wsId, firmId, userId },
      async () => {
        if (!dto.lineItems || dto.lineItems.length === 0) {
          throw new BadRequestException('At least one line item is required');
        }
        const doc = new this.model({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          voucherDate: dto.voucherDate,
          // FY is server-authoritative: derive from the voucher date (April-start, the
          // statutory Indian FY). Never trust a client-supplied financialYear.
          financialYear: this.voucherSeriesService.getFYForDate(new Date(dto.voucherDate)),
          partyId: dto.partyId ? new Types.ObjectId(dto.partyId) : undefined,
          partySnapshot: dto.partySnapshot ?? {},
          placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
          expectedDeliveryDate: dto.expectedDeliveryDate,
          lineItems: dto.lineItems,
          taxableValuePaise: dto.taxableValuePaise,
          cgstPaise: dto.cgstPaise ?? 0,
          sgstPaise: dto.sgstPaise ?? 0,
          igstPaise: dto.igstPaise ?? 0,
          grandTotalPaise: dto.grandTotalPaise,
          notes: dto.notes,
          state: 'draft',
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
        });
        const saved = await doc.save();
        // Fire-and-forget product analytics on the successful draft write (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.created_purchase_order',
          properties: { workspaceId: wsId, firmId, purchaseOrderId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async confirm(wsId: string, firmId: string, id: string, userId: string): Promise<PurchaseOrder> {
    return withFinanceSpan(
      this.tracer,
      'finance.confirmPurchaseOrder',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const po = await this.findOneOrThrow(wsId, firmId, id);
        if (po.state !== 'draft') {
          throw new BadRequestException(`Cannot confirm PO in state '${po.state}'`);
        }
        // FY is server-authoritative: derive from the voucher date (statutory April FY).
        po.financialYear = this.voucherSeriesService.getFYForDate(new Date(po.voucherDate));
        po.voucherNumber = await this.voucherSeriesService.generateNextNumber(
          firmId,
          'purchase_order',
          po.financialYear,
        );
        po.state = 'confirmed';
        po.confirmedBy = new Types.ObjectId(userId);
        po.confirmedAt = new Date();
        (po.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'confirmed',
        });
        const saved = await (po as any).save();
        // Fire-and-forget product analytics on the successful confirm (ids / voucher no only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.confirmed_purchase_order',
          properties: {
            workspaceId: wsId,
            firmId,
            purchaseOrderId: String(saved._id),
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
  ): Promise<PurchaseOrder> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelPurchaseOrder',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const po = await this.findOneOrThrow(wsId, firmId, id);
        if (po.state === 'cancelled') {
          throw new BadRequestException('Purchase Order is already cancelled');
        }
        po.state = 'cancelled';
        (po.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'cancelled',
          reason,
        });
        const saved = await (po as any).save();
        // Fire-and-forget product analytics on the successful cancel (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.cancelled_purchase_order',
          properties: { workspaceId: wsId, firmId, purchaseOrderId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async findOne(wsId: string, firmId: string, id: string): Promise<PurchaseOrder | null> {
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
  ): Promise<PurchaseOrder[]> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.state) filter.state = query.state;
    if (query.dateFrom || query.dateTo) {
      filter.voucherDate = {};
      // Coerce to Date: the HTTP query arrives as ISO strings, and a string vs Date field
      // comparison would not match in Mongo.
      if (query.dateFrom) filter.voucherDate.$gte = new Date(query.dateFrom);
      if (query.dateTo) filter.voucherDate.$lte = new Date(query.dateTo);
    }
    // Party search (q): voucher number prefix or party name. Mirrors the sale-invoice list
    // filter so the purchases list search box works. Regex metachars escaped (WR-05).
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
    dto: Partial<CreatePurchaseOrderDto>,
    userId: string,
  ): Promise<PurchaseOrder> {
    return withFinanceSpan(
      this.tracer,
      'finance.updatePurchaseOrder',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const po = await this.findOneOrThrow(wsId, firmId, id);
        if (po.state !== 'draft') {
          throw new BadRequestException(`Cannot update PO in state '${po.state}'`);
        }
        // Whitelist allowed fields — prevents client injecting state/workspaceId/firmId
        const allowed: (keyof CreatePurchaseOrderDto)[] = [
          'voucherDate',
          'financialYear',
          'partyId',
          'partySnapshot',
          'placeOfSupplyStateCode',
          'expectedDeliveryDate',
          'lineItems',
          'taxableValuePaise',
          'cgstPaise',
          'sgstPaise',
          'igstPaise',
          'grandTotalPaise',
          'notes',
        ];
        for (const key of allowed) {
          if (key in dto) (po as any)[key] = (dto as any)[key];
        }
        (po.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'updated',
        });
        const saved = await (po as any).save();
        // Fire-and-forget product analytics on the successful draft update (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.updated_purchase_order',
          properties: { workspaceId: wsId, firmId, purchaseOrderId: String(saved._id) },
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
  ): Promise<PurchaseOrder> {
    return withFinanceSpan(
      this.tracer,
      'finance.deletePurchaseOrder',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const po = await this.findOneOrThrow(wsId, firmId, id);
        if (po.state === 'confirmed') {
          throw new BadRequestException('Confirmed Purchase Orders cannot be deleted');
        }
        (po as any).isDeleted = true;
        (po as any).deletedAt = new Date();
        (po.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'deleted',
        });
        const saved = await (po as any).save();
        // Fire-and-forget product analytics on the successful soft-delete (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.deleted_purchase_order',
          properties: { workspaceId: wsId, firmId, purchaseOrderId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  private async findOneOrThrow(wsId: string, firmId: string, id: string): Promise<PurchaseOrder> {
    const doc = await this.findOne(wsId, firmId, id);
    if (!doc) throw new NotFoundException('Purchase Order not found');
    return doc;
  }
}
