import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { StockTransfer, StockTransferDocument } from './stock-transfer.schema';
import { Lot, LotDocument } from '../lots/lot.schema';
import { StockMovementsService } from '../stock-movements/stock-movements.service';
import { GodownBalanceService } from '../godown-balances/godown-balance.service';
import { ValuationService } from '../valuation/valuation.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { CreateStockTransferDto } from './dto/create-stock-transfer.dto';
import { UpdateStockTransferDto } from './dto/update-stock-transfer.dto';

@Injectable()
export class StockTransfersService {
  private readonly logger = new Logger(StockTransfersService.name);

  constructor(
    @InjectModel(StockTransfer.name)
    private readonly transferModel: Model<StockTransferDocument>,
    @InjectModel(Lot.name)
    private readonly lotModel: Model<LotDocument>,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly stockMovementsService: StockMovementsService,
    private readonly balanceService: GodownBalanceService,
    private readonly valuationService: ValuationService,
    private readonly voucherSeriesService: VoucherSeriesService,
  ) {}

  /**
   * Derives Indian financial year string (e.g. "2025-26") for a given date.
   * Indian FY: Apr 1 → Mar 31.
   */
  private currentFinancialYear(date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1; // 1-based
    if (month >= 4) {
      return `${year}-${(year + 1).toString().slice(2)}`;
    }
    return `${year - 1}-${year.toString().slice(2)}`;
  }

  async list(
    wsId: string,
    firmId: string,
    filters: { status?: string; from?: Date; to?: Date } = {},
  ) {
    const q: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (filters.status) q.status = filters.status;
    if (filters.from || filters.to) {
      q.date = {};
      if (filters.from) q.date.$gte = filters.from;
      if (filters.to) q.date.$lte = filters.to;
    }
    return this.transferModel.find(q).sort({ date: -1, createdAt: -1 }).lean();
  }

  async findById(wsId: string, firmId: string, id: string): Promise<StockTransferDocument> {
    const doc = await this.transferModel.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException('Stock transfer not found');
    return doc;
  }

  async create(
    wsId: string,
    firmId: string,
    dto: CreateStockTransferDto,
    userId: string,
  ): Promise<StockTransferDocument> {
    if (dto.fromGodownId === dto.toGodownId) {
      throw new BadRequestException('From and To godowns must be different');
    }
    const transferDate = new Date(dto.date);
    const fy = this.currentFinancialYear(transferDate);
    const voucherNo = await this.voucherSeriesService.generateNextNumber(
      firmId,
      'stock_transfer',
      fy,
    );

    const doc = await this.transferModel.create({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      voucherNo,
      date: transferDate,
      fromGodownId: new Types.ObjectId(dto.fromGodownId),
      toGodownId: new Types.ObjectId(dto.toGodownId),
      lines: dto.lines.map((l) => ({
        itemId: new Types.ObjectId(l.itemId),
        lotId: l.lotId ? new Types.ObjectId(l.lotId) : undefined,
        batchId: l.batchId ? new Types.ObjectId(l.batchId) : undefined,
        serialNos: l.serialNos ?? [],
        qty: l.qty,
        narration: l.narration,
      })),
      narration: dto.narration,
      status: 'draft',
      auditLog: [
        {
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'created',
        },
      ],
    });
    return doc;
  }

  async update(
    wsId: string,
    firmId: string,
    id: string,
    dto: UpdateStockTransferDto,
    userId: string,
  ): Promise<StockTransferDocument> {
    const existing = await this.findById(wsId, firmId, id);
    if (existing.status === 'posted') {
      throw new ConflictException('Cannot update a posted transfer');
    }

    if (dto.fromGodownId !== undefined && dto.toGodownId !== undefined) {
      if (dto.fromGodownId === dto.toGodownId) {
        throw new BadRequestException('From and To godowns must be different');
      }
    }

    if (dto.date !== undefined) {
      existing.date = new Date(dto.date);
    }
    if (dto.fromGodownId !== undefined) {
      existing.fromGodownId = new Types.ObjectId(dto.fromGodownId);
    }
    if (dto.toGodownId !== undefined) {
      existing.toGodownId = new Types.ObjectId(dto.toGodownId);
    }
    if (dto.narration !== undefined) {
      existing.narration = dto.narration;
    }
    if (dto.lines !== undefined) {
      existing.lines = dto.lines.map((l) => ({
        itemId: new Types.ObjectId(l.itemId),
        lotId: l.lotId ? new Types.ObjectId(l.lotId) : undefined,
        batchId: l.batchId ? new Types.ObjectId(l.batchId) : undefined,
        serialNos: l.serialNos ?? [],
        qty: l.qty,
        narration: l.narration,
      })) as any;
    }

    existing.auditLog.push({
      at: new Date(),
      by: new Types.ObjectId(userId),
      action: 'updated',
    } as any);

    await existing.save();
    return existing;
  }

  /**
   * Atomic post: validates then creates 2 StockMovement rows per line (transfer_out + transfer_in)
   * plus optional Lot.godownId update for full-lot transfers. All inside one MongoDB session.
   *
   * Short-stock is WARNED (not blocked) per D-01 + pitfall 4.
   * Status guard prevents re-posting (T-09-05-01).
   */
  async post(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<StockTransferDocument> {
    const transfer = await this.findById(wsId, firmId, id);

    // T-09-05-01: Prevent re-posting
    if (transfer.status === 'posted') {
      throw new ConflictException('Transfer already posted');
    }
    if (transfer.lines.length === 0) {
      throw new BadRequestException('Cannot post a transfer with no lines');
    }

    const session: ClientSession = await this.connection.startSession();
    session.startTransaction();

    try {
      for (const line of transfer.lines) {
        // Optional short-stock warning — do NOT block (D-01 + pitfall 4: negative qty allowed)
        const avail = await this.balanceService.getBalance(
          wsId,
          firmId,
          line.itemId.toString(),
          transfer.fromGodownId.toString(),
          'stock',
          session,
        );
        if (avail < line.qty) {
          this.logger.warn(
            `Short-stock on transfer ${transfer.voucherNo}: item ${String(line.itemId)} has ${avail} available at fromGodown, transferring ${line.qty}`,
          );
        }

        // 1. Movement: out from fromGodown (negative qty = outward per D-01 sign convention)
        await this.stockMovementsService.record(
          {
            workspaceId: wsId,
            firmId,
            movementType: 'transfer_out',
            itemId: line.itemId.toString(),
            godownId: transfer.fromGodownId.toString(),
            lotId: line.lotId?.toString(),
            batchId: line.batchId?.toString(),
            serialNos: line.serialNos,
            qty: -line.qty, // negative = outward
            costPaise: 0, // cost preserved via FIFO/MovAvg; transfers don't change valuation
            sourceVoucherId: transfer._id.toString(),
            sourceVoucherType: 'stock_transfer',
            sourceVoucherNumber: transfer.voucherNo,
          },
          userId,
          session,
        );

        // 2. Movement: in to toGodown (positive qty = inward)
        const inMovement = await this.stockMovementsService.record(
          {
            workspaceId: wsId,
            firmId,
            movementType: 'transfer_in',
            itemId: line.itemId.toString(),
            godownId: transfer.toGodownId.toString(),
            lotId: line.lotId?.toString(),
            batchId: line.batchId?.toString(),
            serialNos: line.serialNos,
            qty: line.qty, // positive = inward
            costPaise: 0, // set to the migrated weighted cost below
            sourceVoucherId: transfer._id.toString(),
            sourceVoucherType: 'stock_transfer',
            sourceVoucherNumber: transfer.voucherNo,
          },
          userId,
          session,
        );

        // 2b. Migrate the FIFO cost layer between godowns. record() treats
        // transfers as valuation-neutral (no layer create/consume), which kept
        // the source godown's value but left the cost layer behind — selling
        // from the destination godown then found no layer and booked COGS 0.
        // Consume the source-godown layer(s) for the weighted cost and recreate
        // a destination-godown layer at that same cost: item-total value is
        // unchanged (consume == recreate) but COGS now resolves at either
        // godown. Layers are kept for both FIFO and moving-average firms (D-04),
        // so this runs regardless of method.
        if (line.qty > 0) {
          const { weightedCostPerUnit } = await this.valuationService.consumeFifoLayers(
            wsId,
            firmId,
            line.itemId.toString(),
            transfer.fromGodownId.toString(),
            line.qty,
            session,
          );
          // Mint the destination-godown layer at the migrated cost. createFifoLayer
          // reads costPaise off the movement, so stamp it on the in-memory doc
          // (the layer, not the movement record, is the valuation source of truth).
          inMovement.costPaise = weightedCostPerUnit;
          await this.valuationService.createFifoLayer(inMovement, session);
        }

        // 3. If lot-level transfer AND line.qty matches lot.qtyRemaining → update Lot.godownId
        // (full lot moved to new godown)
        if (line.lotId) {
          const lot = await this.lotModel.findOne({ _id: line.lotId }, null, { session });
          if (lot && lot.qtyRemaining === line.qty) {
            await this.lotModel.updateOne(
              { _id: line.lotId },
              { $set: { godownId: transfer.toGodownId } },
              { session },
            );
          }
        }
      }

      // Flip status + set postedBy/postedAt + audit entry
      transfer.status = 'posted';
      transfer.postedBy = new Types.ObjectId(userId);
      transfer.postedAt = new Date();
      transfer.auditLog.push({
        at: new Date(),
        by: new Types.ObjectId(userId),
        action: 'posted',
      } as any);

      await transfer.save({ session });
      await session.commitTransaction();
      return transfer;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  /**
   * Soft-delete a draft transfer. Posted transfers cannot be deleted (reverse via new transfer).
   * T-09-05-02: prevents edit/delete of posted transfer.
   */
  async delete(wsId: string, firmId: string, id: string, userId: string): Promise<void> {
    const existing = await this.findById(wsId, firmId, id);
    if (existing.status === 'posted') {
      throw new ConflictException('Cannot delete a posted transfer. Reverse via a new transfer.');
    }
    await this.transferModel.updateOne(
      { _id: existing._id },
      {
        $set: { isDeleted: true, deletedAt: new Date() },
        $push: {
          auditLog: {
            at: new Date(),
            by: new Types.ObjectId(userId),
            action: 'deleted',
          },
        },
      },
    );
  }
}
