import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Connection, Document, Model, Types } from 'mongoose';
import { StockMovement, StockMovementDocument } from './stock-movement.schema';
import { Item } from '../../items/item.schema';
import { Firm } from '../../firms/firm.schema';
import { Lot, LotDocument } from '../lots/lot.schema';
import { GodownBalanceService } from '../godown-balances/godown-balance.service';
import { ValuationService } from '../valuation/valuation.service';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { planValuationActions } from './valuation-actions';
import { shouldDecrementLotQty, shouldRestoreLotQty } from './lot-consumption';

// Item and Firm schemas use legacy `extends Document` pattern; create local aliases.
type ItemDocument = Item & Document;
type FirmDocument = Firm & Document;

@Injectable()
export class StockMovementsService {
  private readonly logger = new Logger(StockMovementsService.name);

  constructor(
    @InjectModel(StockMovement.name)
    private readonly movementModel: Model<StockMovementDocument>,
    @InjectModel(Item.name)
    private readonly itemModel: Model<ItemDocument>,
    @InjectModel(Firm.name)
    private readonly firmModel: Model<FirmDocument>,
    @InjectModel(Lot.name)
    private readonly lotModel: Model<LotDocument>,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly balanceService: GodownBalanceService,
    private readonly valuationService: ValuationService,
  ) {}

  /**
   * Records a stock movement atomically with all side effects.
   *
   * Step 0: Read pre-inward GodownBalance + Item.movingAvgCostPaise BEFORE any mutations
   *         (CRITICAL — pitfall 1: MovAvg needs qty BEFORE the $inc)
   * Step 1: Insert StockMovement document
   * Step 2: Upsert GodownBalance via $inc (atomic; negative qty allowed per D-01)
   * Step 3: Update Item.qtyOnHand $inc — ONLY for bucket 'stock' (backward compat for F-02)
   * Step 4: Valuation — read firm's inventoryValuationMethod; FIFO or MovAvg
   *   - Inward: always create FIFO layer (both methods — D-04 keeps layers in parallel)
   *   - Outward + FIFO: consume FIFO layers; update costPaise on movement with weighted avg
   *   - Inward: always recalc MovAvg (D-04: both methods track moving average in parallel)
   *
   * Caller may supply externalSession (when inside a larger voucher transaction).
   * If no session is supplied this method opens and owns its own session.
   *
   * Thread safety (T-09-03-01, T-09-03-02): each call runs inside one MongoDB session.
   * Concurrent callers will serialize at the document level per MongoDB session isolation.
   */
  async record(
    input: CreateStockMovementDto,
    userId: string,
    externalSession?: ClientSession,
  ): Promise<StockMovementDocument> {
    const ownsSession = !externalSession;
    const session = externalSession ?? (await this.connection.startSession());
    if (ownsSession) session.startTransaction();

    try {
      const bucketType = input.bucketType ?? 'stock';

      // STEP 0: Read PRE-inward state for MovAvg formula correctness (pitfall 1).
      // Must happen before ANY mutations inside the transaction.
      const item = await this.itemModel.findOne({ _id: new Types.ObjectId(input.itemId) }, null, {
        session,
      });
      if (!item) {
        throw new BadRequestException(`Item ${input.itemId} not found`);
      }
      const prevAvg = (item as any).movingAvgCostPaise ?? 0;
      // Moving average is an ITEM-GLOBAL figure, so its prior quantity must be
      // the item's TOTAL on-hand (across all godowns), not a single godown's
      // balance — otherwise an item split across godowns is mis-weighted and the
      // recomputed average is wrong.
      const prevItemQty = (item as any).qtyOnHand ?? 0;

      // STEP 1: Insert StockMovement
      const [doc] = await this.movementModel.create(
        [
          {
            workspaceId: new Types.ObjectId(input.workspaceId),
            firmId: new Types.ObjectId(input.firmId),
            movementType: input.movementType,
            itemId: new Types.ObjectId(input.itemId),
            godownId: new Types.ObjectId(input.godownId),
            lotId: input.lotId ? new Types.ObjectId(input.lotId) : undefined,
            batchId: input.batchId ? new Types.ObjectId(input.batchId) : undefined,
            serialNos: input.serialNos ?? [],
            qty: input.qty,
            costPaise: input.costPaise,
            movingAvgCostPaise: prevAvg, // snapshot of avg before this movement
            sourceVoucherId: input.sourceVoucherId
              ? new Types.ObjectId(input.sourceVoucherId)
              : undefined,
            sourceVoucherType: input.sourceVoucherType,
            sourceVoucherNumber: input.sourceVoucherNumber,
            narration: input.narration,
            createdBy: new Types.ObjectId(userId),
          },
        ],
        { session },
      );

      // STEP 2: Upsert GodownBalance via $inc (negative qtyDelta for outward allowed per D-01)
      await this.balanceService.upsertWithSession(
        input.workspaceId,
        input.firmId,
        input.itemId,
        input.godownId,
        bucketType,
        input.qty,
        session,
      );

      // STEP 3: Update Item.qtyOnHand — backward compat for F-02 item scalar.
      // Only for 'stock' bucket: sample/consignment movements do NOT affect qtyOnHand.
      if (bucketType === 'stock') {
        await this.itemModel.updateOne(
          { _id: new Types.ObjectId(input.itemId) },
          { $inc: { qtyOnHand: input.qty } },
          { session },
        );
      }

      // STEP 4: Valuation — determine firm's method
      const firm = await this.firmModel
        .findOne({ _id: new Types.ObjectId(input.firmId) }, null, { session })
        .lean();
      const method = (firm as any)?.inventoryValuationMethod ?? 'moving_average';

      const isInward = input.qty > 0;

      // Route valuation side effects. Transfers + reservations are
      // valuation-neutral: a godown-to-godown move or SO reservation must never
      // recost the item. A transfer_in carries costPaise 0, which would
      // otherwise drag the moving average toward zero and mint a zero-cost FIFO
      // layer in the destination godown.
      const plan = planValuationActions({
        movementType: input.movementType,
        isInward,
        method,
        bucketType,
      });

      if (plan.createFifoLayer) {
        // Both FIFO and MovAvg firms track layers in parallel (D-04) so FIFO
        // reports work even for MovAvg firms.
        await this.valuationService.createFifoLayer(doc, session);
      }

      if (plan.recalcMovingAvg) {
        // prevItemQty + prevAvg are the PRE-inward item-global state (STEP 0).
        await this.valuationService.recalcMovingAvg(
          input.itemId,
          prevItemQty,
          prevAvg,
          input.qty,
          input.costPaise,
          session,
        );
      }

      if (plan.consumeFifoLayers) {
        // FIFO consume on outward (stock bucket only — sample/consignment don't
        // deplete FIFO layers; those are tracked separately).
        const { weightedCostPerUnit } = await this.valuationService.consumeFifoLayers(
          input.workspaceId,
          input.firmId,
          input.itemId,
          input.godownId,
          Math.abs(input.qty),
          session,
        );
        // Back-fill the movement record with the FIFO-computed cost at consumption.
        await this.movementModel.updateOne(
          { _id: doc._id },
          { $set: { costPaise: weightedCostPerUnit } },
          { session },
        );
      }
      // Outward MovAvg firms + valuation-neutral movements: nothing to do. The
      // outward movement snapshot already holds the pre-outward movingAvgCostPaise.

      // Lot bookkeeping: a genuine outward consumption (sale / delivery / wastage
      // / purchase return / manufacturing issue) against a tracked lot must drop
      // that lot's qtyRemaining so empty lots become soft-deletable and the lot
      // drill-down stops overstating. This is lot-level, independent of the FIFO
      // per-godown valuation layers — do not conflate the two. Transfers and
      // reservations are lot-neutral (see shouldDecrementLotQty). Clamp at 0 with
      // a pipeline update so inconsistent data can never push qtyRemaining
      // negative; runs in the same session/txn as the movement.
      if (
        input.lotId &&
        shouldDecrementLotQty({ movementType: input.movementType, isInward, bucketType })
      ) {
        const consumed = Math.abs(input.qty);
        await this.lotModel.updateOne(
          {
            _id: new Types.ObjectId(input.lotId),
            workspaceId: new Types.ObjectId(input.workspaceId),
            firmId: new Types.ObjectId(input.firmId),
          },
          [
            {
              $set: {
                qtyRemaining: { $max: [0, { $subtract: ['$qtyRemaining', consumed] }] },
              },
            },
          ],
          { session },
        );
      }

      // Lot bookkeeping (mirror): a genuine stock RETURN to an existing lot (sales
      // return / manufacturing cancel) restores that lot's qtyRemaining. Clamped
      // at qtyInward so a lot can never exceed its original size. Fresh-stock
      // inwards (purchase_in etc.) are excluded by shouldRestoreLotQty since the
      // lot was already created at qtyRemaining = qtyInward.
      if (
        input.lotId &&
        shouldRestoreLotQty({ movementType: input.movementType, isInward, bucketType })
      ) {
        const restored = Math.abs(input.qty);
        await this.lotModel.updateOne(
          {
            _id: new Types.ObjectId(input.lotId),
            workspaceId: new Types.ObjectId(input.workspaceId),
            firmId: new Types.ObjectId(input.firmId),
          },
          [
            {
              $set: {
                qtyRemaining: { $min: ['$qtyInward', { $add: ['$qtyRemaining', restored] }] },
              },
            },
          ],
          { session },
        );
      }

      if (ownsSession) await session.commitTransaction();
      return doc;
    } catch (err) {
      if (ownsSession) await session.abortTransaction();
      throw err;
    } finally {
      if (ownsSession) session.endSession();
    }
  }

  /**
   * Read-side: movement trail for a specific lot (Lot detail page, traceability).
   * T-09-03-04: workspaceId always included to prevent cross-tenant leakage.
   */
  async findByLot(
    workspaceId: string,
    firmId: string,
    lotId: string,
  ): Promise<StockMovementDocument[]> {
    return (await this.movementModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        lotId: new Types.ObjectId(lotId),
      })
      .sort({ createdAt: -1 })
      .lean()) as unknown as StockMovementDocument[];
  }

  /**
   * Read-side: movement history for an item, with optional godown / type / date filters.
   * T-09-03-04: workspaceId always included.
   */
  async findByItem(
    workspaceId: string,
    firmId: string,
    itemId: string,
    filters: {
      godownId?: string;
      movementType?: string;
      from?: Date;
      to?: Date;
    } = {},
  ): Promise<StockMovementDocument[]> {
    const q: Record<string, any> = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      itemId: new Types.ObjectId(itemId),
    };
    if (filters.godownId) q.godownId = new Types.ObjectId(filters.godownId);
    if (filters.movementType) q.movementType = filters.movementType;
    if (filters.from || filters.to) {
      q.createdAt = {};
      if (filters.from) q.createdAt.$gte = filters.from;
      if (filters.to) q.createdAt.$lte = filters.to;
    }
    return (await this.movementModel
      .find(q)
      .sort({ createdAt: -1 })
      .lean()) as unknown as StockMovementDocument[];
  }
}
