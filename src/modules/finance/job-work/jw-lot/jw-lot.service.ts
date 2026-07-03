import {
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import * as dayjs from 'dayjs';
import { JobWorkLot, JobWorkLotDocument } from './jw-lot.schema';

@Injectable()
export class JwLotService {
  constructor(
    @InjectModel(JobWorkLot.name)
    private readonly lotModel: Model<JobWorkLotDocument>,
  ) {}

  /**
   * Generates lot number "JWL-{YYYYMMDD}-{seq3}" using a per-day per-firm counter.
   * seq = count of existing lots for this firm with same date prefix + lineIndex + 1.
   */
  async generateLotNo(
    firmId: Types.ObjectId,
    date: Date,
    lineIndex: number,
  ): Promise<string> {
    const ymd = dayjs(date).format('YYYYMMDD');
    const prefix = `JWL-${ymd}-`;
    const existing = await this.lotModel.countDocuments({
      firmId,
      lotNo: { $regex: `^${prefix}` },
    });
    const seq = (existing + lineIndex + 1).toString().padStart(3, '0');
    return `${prefix}${seq}`;
  }

  /**
   * Bulk-create lots from JWI line items inside a Mongoose session.
   * One JobWorkLot per line — each gets an auto-generated lotNo and
   * dueReturnDate = inwardDate + 365 days (Section 143 CGST).
   */
  async createBulkFromInwardLines(args: {
    workspaceId: Types.ObjectId;
    firmId: Types.ObjectId;
    principalPartyId: Types.ObjectId;
    inwardChallanId: Types.ObjectId;
    inwardDate: Date;
    godownId: Types.ObjectId;
    lines: { itemDescription: string; hsnCode?: string; unit: string; qty: number }[];
    session?: ClientSession;
  }): Promise<JobWorkLotDocument[]> {
    const dueReturnDate = dayjs(args.inwardDate).add(365, 'day').toDate();

    // Build initial docs with generated lot numbers.
    // All generateLotNo calls are concurrent (Promise.all) so they each read the same
    // countDocuments base and add lineIndex to produce unique sequential numbers.
    const buildDocs = async (offset = 0) =>
      Promise.all(
        args.lines.map(async (line, i) => ({
          workspaceId: args.workspaceId,
          firmId: args.firmId,
          principalPartyId: args.principalPartyId,
          inwardChallanId: args.inwardChallanId,
          challanLineIndex: i,
          lotNo: await this.generateLotNo(args.firmId, args.inwardDate, i + offset),
          itemDescription: line.itemDescription,
          hsnCode: line.hsnCode,
          unit: line.unit,
          qtyInward: line.qty,
          qtyReturnedGood: 0,
          qtyWasted: 0,
          qtyRemaining: line.qty,
          godownId: args.godownId,
          inwardDate: args.inwardDate,
          dueReturnDate,
          status: 'pending' as const,
          isDeleted: false,
        })),
      );

    // Retry on duplicate-key collision (code 11000) — regenerates lot numbers with a
    // fresh countDocuments read so concurrent posts do not surface a raw 500 to callers.
    let attempts = 0;
    while (attempts < 3) {
      const docs = await buildDocs(attempts * 10);
      try {
        return (await this.lotModel.create(docs, {
          session: args.session,
        })) as JobWorkLotDocument[];
      } catch (err: any) {
        if (err?.code === 11000 && attempts < 2) {
          attempts = attempts + 1;
          continue;
        }
        if (err?.code === 11000) {
          throw new ConflictException(
            'Lot number generation conflict — please retry the challan post',
          );
        }
        throw err;
      }
    }
    /* istanbul ignore next */
    throw new ConflictException('Lot number generation failed after retries');
  }

  /**
   * Atomically decrement qtyRemaining using a single-round-trip MongoDB 4.2+ pipeline update.
   * The pipeline computes the new status server-side from the post-decrement qtyRemaining value,
   * eliminating the TOCTOU race that existed when a preliminary read was used to derive newStatus.
   *
   * T-F11-W2-01: concurrent JWOs cannot double-spend qtyRemaining — the $gte guard and the
   * status derivation both happen atomically in the same findOneAndUpdate call.
   */
  async decrementQty(args: {
    lotId: Types.ObjectId;
    qtyGood: number;
    qtyWastage: number;
    session?: ClientSession;
  }): Promise<JobWorkLotDocument> {
    const totalDec = args.qtyGood + args.qtyWastage;

    // Single atomic pipeline update — no preliminary read required.
    // The $gte: totalDec guard in the filter rejects the update if another concurrent
    // request has already consumed qty, making double-spend impossible.
    const result = await this.lotModel.findOneAndUpdate(
      {
        _id: args.lotId,
        qtyRemaining: { $gte: totalDec },
        status: { $in: ['pending', 'partial'] },
      },
      [
        {
          $set: {
            qtyReturnedGood: { $add: ['$qtyReturnedGood', args.qtyGood] },
            qtyWasted: { $add: ['$qtyWasted', args.qtyWastage] },
            qtyRemaining: { $subtract: ['$qtyRemaining', totalDec] },
            status: {
              $cond: {
                if: { $eq: [{ $subtract: ['$qtyRemaining', totalDec] }, 0] },
                then: 'closed',
                else: 'partial',
              },
            },
          },
        },
      ],
      { new: true, session: args.session },
    );
    if (!result) {
      throw new ConflictException(
        `Lot ${args.lotId}: qty insufficient or already closed (concurrent update)`,
      );
    }
    return result;
  }

  /**
   * Pending-material register query — used by JWO form lot picker
   * and the Pending Material dashboard.
   */
  async listPending(args: {
    workspaceId: string;
    firmId: string;
    partyId?: string;
    status?: ('pending' | 'partial' | 'deemed_supply')[];
  }): Promise<JobWorkLotDocument[]> {
    const filter: any = {
      workspaceId: new Types.ObjectId(args.workspaceId),
      firmId: new Types.ObjectId(args.firmId),
      isDeleted: false,
      status: { $in: args.status ?? ['pending', 'partial'] },
    };
    if (args.partyId) {
      filter.principalPartyId = new Types.ObjectId(args.partyId);
    }
    return this.lotModel.find(filter).sort({ inwardDate: 1 }).exec();
  }

  async getByLotNo(
    workspaceId: string,
    firmId: string,
    lotNo: string,
  ): Promise<JobWorkLotDocument | null> {
    return this.lotModel.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      lotNo,
      isDeleted: false,
    });
  }

  async getById(
    id: string,
    workspaceId: string,
    firmId: string,
  ): Promise<JobWorkLotDocument | null> {
    return this.lotModel.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
  }
}
