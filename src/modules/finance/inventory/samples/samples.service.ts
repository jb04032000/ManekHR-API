import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { SampleVoucher, SampleVoucherDocument } from './sample-voucher.schema';
import { Item } from '../../items/item.schema';
import { StockMovementsService } from '../stock-movements/stock-movements.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { SaleInvoiceService } from '../../sales/sale-invoice/sale-invoice.service';
import { CreateSampleVoucherDto } from './dto/create-sample-voucher.dto';
import { UpdateSampleVoucherDto } from './dto/update-sample-voucher.dto';
import { AcceptSampleVoucherDto } from './dto/accept-sample-voucher.dto';
import { ReturnSampleVoucherDto } from './dto/return-sample-voucher.dto';

@Injectable()
export class SamplesService {
  private readonly logger = new Logger(SamplesService.name);

  constructor(
    @InjectModel(SampleVoucher.name)
    private readonly model: Model<SampleVoucherDocument>,
    @InjectModel(Item.name)
    private readonly itemModel: Model<Item>,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly stockMovementsService: StockMovementsService,
    private readonly voucherSeriesService: VoucherSeriesService,
    @Inject(forwardRef(() => SaleInvoiceService))
    private readonly saleInvoiceService: SaleInvoiceService,
  ) {}

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Derives financial year string (e.g. "2025-26") for a given date */
  private getFYForDate(date: Date, fyStartMonth = 4): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    if (month >= fyStartMonth) {
      return `${year}-${(year + 1).toString().slice(2)}`;
    }
    return `${year - 1}-${year.toString().slice(2)}`;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async list(
    workspaceId: string,
    firmId: string,
    filters: {
      status?: string;
      sampleType?: string;
      partyId?: string;
      from?: string;
      to?: string;
    } = {},
  ): Promise<SampleVoucherDocument[]> {
    const q: Record<string, any> = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (filters.status) q.status = filters.status;
    if (filters.sampleType) q.sampleType = filters.sampleType;
    if (filters.partyId) q.partyId = new Types.ObjectId(filters.partyId);
    if (filters.from || filters.to) {
      q.date = {};
      if (filters.from) q.date.$gte = new Date(filters.from);
      if (filters.to) q.date.$lte = new Date(filters.to);
    }
    return (await this.model
      .find(q)
      .sort({ date: -1 })
      .lean()) as unknown as SampleVoucherDocument[];
  }

  async findById(workspaceId: string, firmId: string, id: string): Promise<SampleVoucherDocument> {
    const doc = (await this.model
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .lean()) as unknown as SampleVoucherDocument;
    if (!doc) throw new NotFoundException(`SampleVoucher ${id} not found`);
    return doc;
  }

  async create(
    workspaceId: string,
    firmId: string,
    dto: CreateSampleVoucherDto,
    userId: string,
  ): Promise<SampleVoucherDocument> {
    const date = new Date(dto.date);
    const fy = this.getFYForDate(date);
    const voucherNo = await this.voucherSeriesService.generateNextNumber(
      firmId,
      'sample_voucher',
      fy,
    );

    const doc = await this.model.create({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      voucherNo,
      sampleType: dto.sampleType,
      date,
      partyId: new Types.ObjectId(dto.partyId),
      deliveryAddress: dto.deliveryAddress,
      lines: dto.lines.map((l) => ({
        itemId: new Types.ObjectId(l.itemId),
        godownId: new Types.ObjectId(l.godownId),
        lotId: l.lotId ? new Types.ObjectId(l.lotId) : undefined,
        batchId: l.batchId ? new Types.ObjectId(l.batchId) : undefined,
        serialNos: l.serialNos ?? [],
        qty: l.qty,
        acceptedQty: 0,
        returnedQty: 0,
        rate: l.rate,
        remarks: l.remarks,
      })),
      expectedReturnDate: new Date(dto.expectedReturnDate),
      autoAlarmDays: dto.autoAlarmDays ?? 7,
      narration: dto.narration,
      status: 'draft',
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'create' }],
    });

    return doc;
  }

  async update(
    workspaceId: string,
    firmId: string,
    id: string,
    dto: UpdateSampleVoucherDto,
    userId: string,
  ): Promise<SampleVoucherDocument> {
    const voucher = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!voucher) throw new NotFoundException(`SampleVoucher ${id} not found`);

    const editableStatuses = ['draft', 'sent', 'partially_accepted'];
    if (!editableStatuses.includes(voucher.status)) {
      throw new BadRequestException(
        `Cannot update voucher in status '${voucher.status}'. Allowed: ${editableStatuses.join(', ')}`,
      );
    }

    const updateFields: Record<string, any> = {};
    if (dto.date !== undefined) updateFields.date = new Date(dto.date);
    if (dto.partyId !== undefined) updateFields.partyId = new Types.ObjectId(dto.partyId);
    if (dto.deliveryAddress !== undefined) updateFields.deliveryAddress = dto.deliveryAddress;
    if (dto.expectedReturnDate !== undefined)
      updateFields.expectedReturnDate = new Date(dto.expectedReturnDate);
    if (dto.autoAlarmDays !== undefined) updateFields.autoAlarmDays = dto.autoAlarmDays;
    if (dto.narration !== undefined) updateFields.narration = dto.narration;
    if (dto.lines !== undefined) {
      updateFields.lines = dto.lines.map((l) => ({
        itemId: new Types.ObjectId(l.itemId),
        godownId: new Types.ObjectId(l.godownId),
        lotId: l.lotId ? new Types.ObjectId(l.lotId) : undefined,
        batchId: l.batchId ? new Types.ObjectId(l.batchId) : undefined,
        serialNos: l.serialNos ?? [],
        qty: l.qty,
        acceptedQty: 0,
        returnedQty: 0,
        rate: l.rate,
        remarks: l.remarks,
      }));
    }

    const updated = (await this.model
      .findOneAndUpdate(
        { _id: new Types.ObjectId(id) },
        {
          $set: updateFields,
          $push: { auditLog: { at: new Date(), by: new Types.ObjectId(userId), action: 'update' } },
        },
        { new: true },
      )
      .lean()) as unknown as SampleVoucherDocument;

    return updated;
  }

  // ─── Post ─────────────────────────────────────────────────────────────────

  /**
   * Post a draft SampleVoucher:
   *  - Rejects if status !== 'draft'
   *  - For each line: records a sample_out (or consignment_out) StockMovement
   *    with the appropriate bucketType ('sample' | 'consignment')
   *  - Promotes status to 'sent'
   *  - All mutations run inside a single MongoDB session/transaction
   */
  async post(
    workspaceId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<SampleVoucherDocument> {
    const voucher = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!voucher) throw new NotFoundException(`SampleVoucher ${id} not found`);
    if (voucher.status !== 'draft') {
      throw new BadRequestException(
        `Cannot post voucher in status '${voucher.status}'. Only 'draft' vouchers can be posted.`,
      );
    }

    const session: ClientSession = await this.connection.startSession();
    session.startTransaction();

    try {
      const bucketType = voucher.sampleType === 'sample' ? 'sample' : 'consignment';
      const movementType = voucher.sampleType === 'sample' ? 'sample_out' : 'consignment_out';

      for (const line of voucher.lines) {
        await this.stockMovementsService.record(
          {
            workspaceId,
            firmId,
            movementType,
            itemId: line.itemId.toString(),
            godownId: line.godownId.toString(),
            lotId: line.lotId?.toString(),
            batchId: line.batchId?.toString(),
            serialNos: line.serialNos,
            qty: -line.qty, // outward = negative per D-01 sign convention
            costPaise: line.rate ?? 0,
            sourceVoucherId: (voucher as any)._id.toString(),
            sourceVoucherType: 'sample_voucher',
            sourceVoucherNumber: voucher.voucherNo,
            narration: voucher.narration,
            bucketType,
          },
          userId,
          session,
        );
      }

      const now = new Date();
      await this.model.updateOne(
        { _id: (voucher as any)._id },
        {
          $set: { status: 'sent', postedAt: now, postedBy: new Types.ObjectId(userId) },
          $push: { auditLog: { at: now, by: new Types.ObjectId(userId), action: 'post' } },
        },
        { session },
      );

      await session.commitTransaction();

      return this.findById(workspaceId, firmId, id);
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ─── Accept ───────────────────────────────────────────────────────────────

  /**
   * Accept (partial or full) goods from a sample/consignment:
   *
   * For each accepted line:
   *   1. sample_return_in (positive qty) against sample/consignment bucket — drains sample bucket
   *   2. sale_out (negative qty) against stock bucket — realizes the sale
   *
   * Status transitions:
   *   - All lines fully resolved (accepted + returned >= qty) + at least 1 accepted → 'fully_accepted'
   *   - Otherwise → 'partially_accepted'
   *
   * TODO F-09-08: invoke saleInvoiceService.createDraftFromSample(voucher, dto.lines)
   * to create a Tax Invoice draft. SaleInvoiceModule import is deferred to F-09-08
   * to avoid a circular dependency at this module layer.
   */
  async accept(
    workspaceId: string,
    firmId: string,
    id: string,
    dto: AcceptSampleVoucherDto,
    userId: string,
  ): Promise<SampleVoucherDocument> {
    const voucher = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!voucher) throw new NotFoundException(`SampleVoucher ${id} not found`);

    const allowedStatuses = ['sent', 'partially_accepted'];
    if (!allowedStatuses.includes(voucher.status)) {
      throw new BadRequestException(
        `Cannot accept voucher in status '${voucher.status}'. Allowed: ${allowedStatuses.join(', ')}`,
      );
    }

    // Validate all lineIdx and acceptedQty values before opening a session
    for (const entry of dto.lines) {
      if (entry.lineIdx < 0 || entry.lineIdx >= voucher.lines.length) {
        throw new BadRequestException(`lineIdx ${entry.lineIdx} is out of range`);
      }
      const line = voucher.lines[entry.lineIdx];
      const remaining = line.qty - line.acceptedQty - line.returnedQty;
      if (entry.acceptedQty > remaining) {
        throw new BadRequestException(
          `acceptedQty (${entry.acceptedQty}) exceeds remaining qty (${remaining}) for lineIdx ${entry.lineIdx}`,
        );
      }
    }

    const session: ClientSession = await this.connection.startSession();
    session.startTransaction();

    try {
      const bucketType = voucher.sampleType === 'sample' ? 'sample' : 'consignment';

      for (const entry of dto.lines) {
        if (entry.acceptedQty <= 0) continue;
        const line = voucher.lines[entry.lineIdx];

        // Movement 1: drain the sample/consignment bucket
        // sample_return_in with positive qty removes items from sample GodownBalance
        await this.stockMovementsService.record(
          {
            workspaceId,
            firmId,
            movementType: 'sample_return_in',
            itemId: line.itemId.toString(),
            godownId: line.godownId.toString(),
            qty: entry.acceptedQty,
            costPaise: line.rate ?? 0,
            sourceVoucherId: (voucher as any)._id.toString(),
            sourceVoucherType: 'sample_voucher',
            sourceVoucherNumber: voucher.voucherNo,
            narration: `Accept from ${voucher.voucherNo}`,
            bucketType,
          },
          userId,
          session,
        );

        // Movement 2: deduct from stock bucket to realize the sale
        await this.stockMovementsService.record(
          {
            workspaceId,
            firmId,
            movementType: 'sale_out',
            itemId: line.itemId.toString(),
            godownId: line.godownId.toString(),
            qty: -entry.acceptedQty, // outward = negative per D-01
            costPaise: line.rate ?? 0,
            sourceVoucherId: (voucher as any)._id.toString(),
            sourceVoucherType: 'sample_voucher',
            sourceVoucherNumber: voucher.voucherNo,
            narration: `Sale realized from sample ${voucher.voucherNo}`,
            bucketType: 'stock',
          },
          userId,
          session,
        );

        // Update line acceptedQty in-memory
        voucher.lines[entry.lineIdx].acceptedQty += entry.acceptedQty;
      }

      // Recompute status
      const allResolved = voucher.lines.every((l) => l.acceptedQty + l.returnedQty >= l.qty);
      const anyAccepted = voucher.lines.some((l) => l.acceptedQty > 0);
      let newStatus = voucher.status;
      if (allResolved && anyAccepted) {
        newStatus = 'fully_accepted';
      } else if (anyAccepted) {
        newStatus = 'partially_accepted';
      }

      // F-09-08 (D-07): create draft Tax Invoice from this acceptance
      let acceptedInvoiceId: Types.ObjectId | undefined;
      const acceptedForInvoice = dto.lines.filter((al) => al.acceptedQty > 0);
      if (acceptedForInvoice.length > 0) {
        try {
          const draftInvoice = await this.saleInvoiceService.createDraftFromSample(
            voucher,
            acceptedForInvoice,
            userId,
          );
          acceptedInvoiceId = (draftInvoice as any)._id;
        } catch (err) {
          this.logger.warn(
            `createDraftFromSample failed for voucher ${voucher.voucherNo}: ${err.message}`,
          );
        }
      }

      const now = new Date();
      const setFields: Record<string, any> = {
        lines: voucher.lines,
        status: newStatus,
      };
      if (acceptedInvoiceId) setFields.acceptedInvoiceId = acceptedInvoiceId;

      await this.model.updateOne(
        { _id: (voucher as any)._id },
        {
          $set: setFields,
          $push: { auditLog: { at: now, by: new Types.ObjectId(userId), action: 'accept' } },
        },
        { session },
      );

      await session.commitTransaction();
      return this.findById(workspaceId, firmId, id);
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ─── Return ───────────────────────────────────────────────────────────────

  /**
   * Return (reject) goods back to stock from a sample/consignment.
   *
   * Two-movement approach per D-07:
   *   1. sample_return_in (+returnedQty, bucketType='stock') — restores goods to original godown
   *   2. sample_return_in (-returnedQty, bucketType='sample'/'consignment') — drains sample bucket
   *
   * Status transitions:
   *   - All lines returnedQty >= qty → 'rejected_returned'
   *   - Otherwise keep 'partially_accepted'
   */
  async return(
    workspaceId: string,
    firmId: string,
    id: string,
    dto: ReturnSampleVoucherDto,
    userId: string,
  ): Promise<SampleVoucherDocument> {
    const voucher = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!voucher) throw new NotFoundException(`SampleVoucher ${id} not found`);

    const allowedStatuses = ['sent', 'partially_accepted'];
    if (!allowedStatuses.includes(voucher.status)) {
      throw new BadRequestException(
        `Cannot return voucher in status '${voucher.status}'. Allowed: ${allowedStatuses.join(', ')}`,
      );
    }

    // Validate all lineIdx and returnedQty values before opening a session
    for (const entry of dto.lines) {
      if (entry.lineIdx < 0 || entry.lineIdx >= voucher.lines.length) {
        throw new BadRequestException(`lineIdx ${entry.lineIdx} is out of range`);
      }
      const line = voucher.lines[entry.lineIdx];
      const remaining = line.qty - line.acceptedQty - line.returnedQty;
      if (entry.returnedQty > remaining) {
        throw new BadRequestException(
          `returnedQty (${entry.returnedQty}) exceeds remaining qty (${remaining}) for lineIdx ${entry.lineIdx}`,
        );
      }
    }

    const session: ClientSession = await this.connection.startSession();
    session.startTransaction();

    try {
      const bucketType = voucher.sampleType === 'sample' ? 'sample' : 'consignment';

      for (const entry of dto.lines) {
        if (entry.returnedQty <= 0) continue;
        const line = voucher.lines[entry.lineIdx];

        // Movement 1: restore goods to original stock godown (+returnedQty into stock bucket).
        // Re-enter at the item's carrying cost (current moving-average), NOT the
        // sample voucher's rate (a notional/sale rate) — costing the stock
        // re-entry at the sale rate would corrupt the FIFO layer and inflate the
        // moving average.
        const itemForCost = await this.itemModel
          .findOne({ _id: line.itemId }, { movingAvgCostPaise: 1 }, { session })
          .lean();
        const reentryCostPaise = (itemForCost as any)?.movingAvgCostPaise ?? 0;
        await this.stockMovementsService.record(
          {
            workspaceId,
            firmId,
            movementType: 'sample_return_in',
            itemId: line.itemId.toString(),
            godownId: line.godownId.toString(),
            qty: entry.returnedQty, // positive = inward to stock
            costPaise: reentryCostPaise,
            sourceVoucherId: (voucher as any)._id.toString(),
            sourceVoucherType: 'sample_voucher',
            sourceVoucherNumber: voucher.voucherNo,
            narration: `Return to stock from ${voucher.voucherNo}`,
            bucketType: 'stock',
          },
          userId,
          session,
        );

        // Movement 2: drain sample/consignment bucket (-returnedQty from sample bucket)
        await this.stockMovementsService.record(
          {
            workspaceId,
            firmId,
            movementType: 'sample_return_in',
            itemId: line.itemId.toString(),
            godownId: line.godownId.toString(),
            qty: -entry.returnedQty, // negative = outward from sample bucket
            costPaise: line.rate ?? 0,
            sourceVoucherId: (voucher as any)._id.toString(),
            sourceVoucherType: 'sample_voucher',
            sourceVoucherNumber: voucher.voucherNo,
            narration: `Drain sample bucket on return from ${voucher.voucherNo}`,
            bucketType,
          },
          userId,
          session,
        );

        // Update line returnedQty in-memory
        voucher.lines[entry.lineIdx].returnedQty += entry.returnedQty;
      }

      // Recompute status
      const allFullyReturned = voucher.lines.every((l) => l.returnedQty >= l.qty);
      const anyReturned = voucher.lines.some((l) => l.returnedQty > 0);
      let newStatus = voucher.status;
      const now = new Date();
      let returnedAt: Date | undefined;

      if (allFullyReturned) {
        newStatus = 'rejected_returned';
        returnedAt = now;
      } else if (anyReturned) {
        newStatus = 'partially_accepted';
      }

      const setFields: Record<string, any> = {
        lines: voucher.lines,
        status: newStatus,
      };
      if (returnedAt) setFields.returnedAt = returnedAt;

      await this.model.updateOne(
        { _id: (voucher as any)._id },
        {
          $set: setFields,
          $push: { auditLog: { at: now, by: new Types.ObjectId(userId), action: 'return' } },
        },
        { session },
      );

      await session.commitTransaction();
      return this.findById(workspaceId, firmId, id);
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /** Soft delete — only allowed when status === 'draft' */
  async delete(workspaceId: string, firmId: string, id: string, userId: string): Promise<void> {
    const voucher = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!voucher) throw new NotFoundException(`SampleVoucher ${id} not found`);
    if (voucher.status !== 'draft') {
      throw new BadRequestException(
        `Cannot delete voucher in status '${voucher.status}'. Only draft vouchers can be deleted.`,
      );
    }

    await this.model.updateOne(
      { _id: (voucher as any)._id },
      {
        $set: { isDeleted: true, deletedAt: new Date() },
        $push: { auditLog: { at: new Date(), by: new Types.ObjectId(userId), action: 'delete' } },
      },
    );
  }
}
