import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Document, Model, Types } from 'mongoose';
import {
  ItemValuationLayer,
  ItemValuationLayerDocument,
} from './item-valuation-layer.schema';
import { Item } from '../../items/item.schema';
import { StockMovementDocument } from '../stock-movements/stock-movement.schema';

// Item uses legacy `extends Document` pattern; create local alias for type safety.
type ItemDocument = Item & Document;

@Injectable()
export class ValuationService {
  private readonly logger = new Logger(ValuationService.name);

  constructor(
    @InjectModel(ItemValuationLayer.name)
    private readonly layerModel: Model<ItemValuationLayerDocument>,
    @InjectModel(Item.name)
    private readonly itemModel: Model<ItemDocument>,
  ) {}

  /**
   * Create a new FIFO layer when stock comes in (inward movement).
   * Sequence is determined atomically within the same session:
   * max(seq) + 1 within {workspaceId, firmId, itemId, godownId}.
   */
  async createFifoLayer(
    movement: StockMovementDocument,
    session: ClientSession,
  ): Promise<ItemValuationLayerDocument> {
    const last = await this.layerModel
      .findOne(
        {
          workspaceId: movement.workspaceId,
          firmId: movement.firmId,
          itemId: movement.itemId,
          godownId: movement.godownId,
        },
        null,
        { session, sort: { seq: -1 } },
      )
      .lean();

    const seq = (last?.seq ?? 0) + 1;

    const [layer] = await this.layerModel.create(
      [
        {
          workspaceId: movement.workspaceId,
          firmId: movement.firmId,
          itemId: movement.itemId,
          godownId: movement.godownId,
          seq,
          qtyOriginal: movement.qty,
          qtyRemaining: movement.qty,
          costPaise: movement.costPaise,
          inDate: (movement as any).createdAt ?? new Date(),
          sourceMovementId: movement._id,
          isExhausted: false,
        },
      ],
      { session },
    );

    return layer;
  }

  /**
   * Consume FIFO layers for an outward movement.
   * Iterates layers in seq ASC order (FIFO — oldest first).
   * Returns total qty consumed + weighted-average cost per unit in paise.
   *
   * CRITICAL (pitfall 2): query uses isExhausted:false so MongoDB can use
   * the compound index {ws,firm,item,godown,isExhausted,seq} for IXSCAN.
   *
   * T-09-03-03: log warning when >100 active layers (TransactionTooLargeForCache risk).
   */
  async consumeFifoLayers(
    workspaceId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    itemId: string | Types.ObjectId,
    godownId: string | Types.ObjectId,
    qtyToConsume: number,
    session: ClientSession,
  ): Promise<{ totalConsumed: number; weightedCostPerUnit: number }> {
    const wsId =
      typeof workspaceId === 'string'
        ? new Types.ObjectId(workspaceId)
        : workspaceId;
    const fId =
      typeof firmId === 'string' ? new Types.ObjectId(firmId) : firmId;
    const iId =
      typeof itemId === 'string' ? new Types.ObjectId(itemId) : itemId;
    const gId =
      typeof godownId === 'string' ? new Types.ObjectId(godownId) : godownId;

    let remaining = qtyToConsume;
    let weightedCostSum = 0;
    let totalConsumed = 0;

    const layers = await this.layerModel.find(
      {
        workspaceId: wsId,
        firmId: fId,
        itemId: iId,
        godownId: gId,
        isExhausted: false,
      },
      null,
      { session, sort: { seq: 1 } },
    );

    // T-09-03-03: warn before risk of TransactionTooLargeForCache
    if (layers.length > 100) {
      this.logger.warn(
        `FIFO layer count ${layers.length} > 100 for item ${iId} in godown ${gId}. ` +
          'Risk of TransactionTooLargeForCache on high-volume consumption.',
      );
    }

    for (const layer of layers) {
      if (remaining <= 0) break;
      const consumed = Math.min(layer.qtyRemaining, remaining);
      weightedCostSum += consumed * layer.costPaise;
      totalConsumed += consumed;
      remaining -= consumed;
      const newRemaining = layer.qtyRemaining - consumed;

      await this.layerModel.updateOne(
        { _id: layer._id },
        {
          $inc: { qtyRemaining: -consumed },
          ...(newRemaining === 0 ? { $set: { isExhausted: true } } : {}),
        },
        { session },
      );
    }

    const weightedCostPerUnit =
      totalConsumed > 0 ? Math.round(weightedCostSum / totalConsumed) : 0;
    return { totalConsumed, weightedCostPerUnit };
  }

  /**
   * Recalculate Moving Average cost after an inward movement.
   *
   * CRITICAL (pitfall 1): caller MUST pass PRE-inward qty and PRE-inward avg.
   * Do NOT call this after Item.qtyOnHand has already been incremented.
   *
   * Formula: newAvg = (prevQty * prevAvgCost + inwardQty * inwardCost) / totalQty
   * All cost values are in paise (integer). Result is Math.round() to avoid drift.
   */
  async recalcMovingAvg(
    itemId: string | Types.ObjectId,
    prevQty: number,
    prevAvgCostPaise: number,
    inwardQty: number,
    inwardCostPaise: number,
    session: ClientSession,
  ): Promise<number> {
    const iId =
      typeof itemId === 'string' ? new Types.ObjectId(itemId) : itemId;

    const safePrevQty = Math.max(0, prevQty);
    const totalQty = safePrevQty + inwardQty;
    const newAvg =
      totalQty > 0
        ? Math.round(
            (safePrevQty * prevAvgCostPaise + inwardQty * inwardCostPaise) /
              totalQty,
          )
        : inwardCostPaise;

    await this.itemModel.updateOne(
      { _id: iId },
      { $set: { movingAvgCostPaise: newAvg } },
      { session },
    );

    return newAvg;
  }
}
