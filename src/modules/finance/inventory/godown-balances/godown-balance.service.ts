import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  GodownBalance,
  GodownBalanceDocument,
} from './godown-balance.schema';

@Injectable()
export class GodownBalanceService {
  constructor(
    @InjectModel(GodownBalance.name)
    private readonly balanceModel: Model<GodownBalanceDocument>,
  ) {}

  /**
   * Returns the current qty for an item in a specific godown and bucket.
   * Defaults to 'stock' bucket. Returns 0 if no balance doc exists yet.
   * Optional session for use within a transaction.
   */
  async getBalance(
    workspaceId: string,
    firmId: string,
    itemId: string,
    godownId: string,
    bucketType: 'stock' | 'sample' | 'consignment' = 'stock',
    session?: ClientSession,
  ): Promise<number> {
    const doc = await this.balanceModel
      .findOne(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
          itemId: new Types.ObjectId(itemId),
          godownId: new Types.ObjectId(godownId),
          bucketType,
        },
        null,
        { session },
      )
      .lean();
    return doc?.qty ?? 0;
  }

  /**
   * Returns all balance records (stock bucket only) for a specific godown.
   * Used for godown-level stock report UI.
   */
  async listForGodown(
    workspaceId: string,
    firmId: string,
    godownId: string,
  ): Promise<GodownBalanceDocument[]> {
    return this.balanceModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        godownId: new Types.ObjectId(godownId),
        bucketType: 'stock',
      })
      .lean() as unknown as GodownBalanceDocument[];
  }

  /**
   * Returns all balance records for a specific item across all godowns.
   * Used for item-level stock distribution UI (shows all buckets).
   */
  async listForItem(
    workspaceId: string,
    firmId: string,
    itemId: string,
  ): Promise<GodownBalanceDocument[]> {
    return this.balanceModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        itemId: new Types.ObjectId(itemId),
      })
      .lean() as unknown as GodownBalanceDocument[];
  }

  /**
   * Internal: upserts balance within a session via $inc on qty.
   * Only called from StockMovementsService.record() — NOT a public mutation API.
   * Negative qtyDelta is permitted (short-stock allowed per D-01).
   */
  async upsertWithSession(
    workspaceId: string,
    firmId: string,
    itemId: string,
    godownId: string,
    bucketType: 'stock' | 'sample' | 'consignment',
    qtyDelta: number,
    session: ClientSession,
  ): Promise<void> {
    await this.balanceModel.findOneAndUpdate(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        itemId: new Types.ObjectId(itemId),
        godownId: new Types.ObjectId(godownId),
        bucketType,
      },
      {
        $inc: { qty: qtyDelta },
        $set: { lastMovementAt: new Date() },
      },
      { upsert: true, new: true, session },
    );
  }
}
