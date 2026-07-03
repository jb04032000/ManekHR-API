import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Item } from '../../items/item.schema';
import { LineItem } from '../voucher-base/voucher-base.interface';
import { StockMovementsService } from '../../inventory/stock-movements/stock-movements.service';
import { FirmsService } from '../../firms/firms.service';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectModel(Item.name)
    private readonly itemModel: Model<Item>,
    private readonly stockMovementsService: StockMovementsService,
    @Inject(forwardRef(() => FirmsService))
    private readonly firmsService: FirmsService,
  ) {}

  // ─── private helpers ───────────────────────────────────────────────────────

  private async resolveGodownId(
    firmId: string,
    lineGodownId?: Types.ObjectId | string,
  ): Promise<string> {
    if (lineGodownId) return lineGodownId.toString();
    const def = await this.firmsService.getDefaultGodownId(
      new Types.ObjectId(firmId),
    );
    if (!def) {
      throw new BadRequestException(
        `No default godown found for firm ${firmId}. Run migration to seed Main Godown.`,
      );
    }
    return def.toString();
  }

  // ─── reserve ──────────────────────────────────────────────────────────────

  /**
   * Reserve stock for a Sale Order: increments Item.reservedQty for each line.
   * Does NOT decrement qtyOnHand (reservation only).
   * Does NOT create StockMovement records — reservations are Item-level only.
   */
  async reserve(
    workspaceId: string,
    firmId: string,
    lineItems: LineItem[],
    opts: { session?: ClientSession } = {},
  ): Promise<void> {
    for (const line of lineItems) {
      await this.itemModel.updateOne(
        {
          _id: new Types.ObjectId(line.itemId.toString()),
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
        },
        { $inc: { reservedQty: line.qty } },
        { session: opts.session },
      );
    }
  }

  // ─── releaseReservation ────────────────────────────────────────────────────

  /**
   * Release a Sale Order's stock reservation: decrements Item.reservedQty.
   * Called when DC converts the SO (consuming reservation) or SO is cancelled.
   * Does NOT create StockMovement records — reservations are Item-level only.
   */
  async releaseReservation(
    workspaceId: string,
    firmId: string,
    lineItems: LineItem[],
    opts: { session?: ClientSession } = {},
  ): Promise<void> {
    for (const line of lineItems) {
      await this.itemModel.updateOne(
        {
          _id: new Types.ObjectId(line.itemId.toString()),
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
        },
        { $inc: { reservedQty: -line.qty } },
        { session: opts.session },
      );
    }
  }

  // ─── stockOut ─────────────────────────────────────────────────────────────

  /**
   * Decrease stock for each line item (DC post or direct Tax Invoice).
   * Delegates to StockMovementsService.record() which atomically updates
   * GodownBalance, qtyOnHand, and FIFO/MovAvg valuation layers.
   *
   * opts is OPTIONAL — existing call sites passing (workspaceId, firmId, lines)
   * continue to compile and work with safe defaults.
   */
  async stockOut(
    workspaceId: string,
    firmId: string,
    lines: LineItem[],
    opts?: {
      session?: ClientSession;
      movementType?: 'sale_out' | 'dc_out' | 'debit_note_out' | 'purchase_return_out';
      sourceVoucherId?: string;
      sourceVoucherType?: string;
      sourceVoucherNumber?: string;
      userId?: string;
    },
  ): Promise<void> {
    const movementType = opts?.movementType ?? 'sale_out';
    const userId = opts?.userId ?? '000000000000000000000000';
    for (const line of lines) {
      const godownId = await this.resolveGodownId(firmId, line.godownId);
      await this.stockMovementsService.record(
        {
          workspaceId,
          firmId,
          movementType,
          itemId: line.itemId.toString(),
          godownId,
          lotId: line.lotId?.toString(),
          batchId: line.batchId?.toString(),
          serialNos: line.serialNos,
          qty: -Math.abs(line.qty),
          costPaise: line.costPaise ?? 0,
          sourceVoucherId: opts?.sourceVoucherId,
          sourceVoucherType: opts?.sourceVoucherType,
          sourceVoucherNumber: opts?.sourceVoucherNumber,
        },
        userId,
        opts?.session,
      );
    }
  }

  // ─── stockIn ──────────────────────────────────────────────────────────────

  /**
   * Increase stock for each line item — used for invoice cancel reversal or
   * purchase return. Delegates to StockMovementsService.record().
   *
   * opts is OPTIONAL — existing call sites continue to work with safe defaults.
   */
  async stockIn(
    workspaceId: string,
    firmId: string,
    lines: LineItem[],
    opts?: {
      session?: ClientSession;
      movementType?: 'purchase_in' | 'grn_in' | 'credit_note_in' | 'manufacturing_in' | 'opening_stock';
      sourceVoucherId?: string;
      sourceVoucherType?: string;
      sourceVoucherNumber?: string;
      userId?: string;
    },
  ): Promise<void> {
    const movementType = opts?.movementType ?? 'purchase_in';
    const userId = opts?.userId ?? '000000000000000000000000';
    for (const line of lines) {
      const godownId = await this.resolveGodownId(firmId, line.godownId);
      const cost =
        line.costPaise ??
        (line as any).purchaseRatePaise ??
        (line as any).ratePaise ??
        0;
      await this.stockMovementsService.record(
        {
          workspaceId,
          firmId,
          movementType,
          itemId: line.itemId.toString(),
          godownId,
          lotId: line.lotId?.toString(),
          batchId: line.batchId?.toString(),
          serialNos: line.serialNos,
          qty: Math.abs(line.qty),
          costPaise: cost,
          sourceVoucherId: opts?.sourceVoucherId,
          sourceVoucherType: opts?.sourceVoucherType,
          sourceVoucherNumber: opts?.sourceVoucherNumber,
        },
        userId,
        opts?.session,
      );
    }
  }
}
