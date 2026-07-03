import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  LotDailyCounter,
  LotDailyCounterDocument,
} from './lot-daily-counter.schema';

@Injectable()
export class LotDailyCounterService {
  constructor(
    @InjectModel(LotDailyCounter.name)
    private readonly counterModel: Model<LotDailyCounterDocument>,
  ) {}

  /**
   * Atomically reserves the next sequence number for a given
   * workspace + firm + item + date combination.
   * Uses findOneAndUpdate with $inc + upsert so concurrent callers
   * on the same key never produce duplicate sequence numbers.
   *
   * @param workspaceId - workspace ObjectId or string
   * @param firmId      - firm ObjectId or string
   * @param itemId      - item ObjectId or string
   * @param dateStr     - date in YYYYMMDD format (e.g. "20260428")
   * @returns           - the reserved sequence number (starts at 1)
   */
  async reserveNextLotSeq(
    workspaceId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    itemId: string | Types.ObjectId,
    dateStr: string,
  ): Promise<number> {
    const counter = await this.counterModel.findOneAndUpdate(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        itemId: new Types.ObjectId(itemId),
        date: dateStr,
      },
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    );
    return counter.seq;
  }

  /**
   * Formats a lot number from its components.
   * Format: {itemCode}-{dateStr}-{zeroPaddedSeq}
   * Example: ITEM001-20260428-003
   *
   * Matches CONTEXT.md specifics #6 and RESEARCH.md Pattern 10.
   */
  formatLotNo(itemCode: string, dateStr: string, seq: number): string {
    return `${itemCode}-${dateStr}-${String(seq).padStart(3, '0')}`;
  }
}
