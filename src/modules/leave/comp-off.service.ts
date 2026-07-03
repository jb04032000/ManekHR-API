import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LeaveLedger, LeaveLedgerSourceKind } from './schemas/leave-ledger.schema';
import { LeaveLedgerService } from './leave-ledger.service';
import { allocateFifo, CompOffAllocation, CompOffLot } from './leave-comp-off.util';

const DAY_MS = 86_400_000;

export interface CreditCompOffInput {
  workspaceId: string;
  teamMemberId: string;
  compOffLeaveTypeId: string;
  /** The holiday / week-off worked that earned this lot. */
  sourceWorkDate: Date;
  quantity: number;
  /** Lot lifetime — from `LeaveType.compOff.validityDays`. */
  validityDays: number;
  sourceRef: { kind: LeaveLedgerSourceKind; id: Types.ObjectId | null };
  actorUserId?: Types.ObjectId | null;
}

export interface ConsumeCompOffInput {
  workspaceId: string;
  teamMemberId: string;
  compOffLeaveTypeId: string;
  quantity: number;
  asOf: Date;
  sourceRef: { kind: LeaveLedgerSourceKind; id: Types.ObjectId | null };
  actorUserId?: Types.ObjectId | null;
}

export interface ConsumeCompOffResult {
  consumed: number;
  lots: CompOffAllocation[];
}

export interface CompOffExpiryResult {
  lotsExpired: number;
  daysExpired: number;
  errors: string[];
}

/** A member-facing view of one active comp-off lot — worker self-service (L6b). */
export interface CompOffLotView {
  ledgerEntryId: string;
  /** The holiday / weekly-off worked that earned this lot. */
  sourceWorkDate: string;
  /** Days originally credited to the lot. */
  creditedDays: number;
  /** Unconsumed days remaining in the lot. */
  remainingDays: number;
  /** When the lot lapses if unused. */
  expiresOn: string;
}

/**
 * Comp-off lot lifecycle (L2b) — credit, FIFO consumption, expiry.
 *
 * A comp-off credit is a discrete *lot*: a `comp_off_credit` ledger entry with
 * `lotRemaining` + `lotExpiresOn`. Consumption draws oldest-expiry-first;
 * `lotRemaining` is the single mutable ledger field. Lots are tracked in the
 * calendar year they were earned and are NOT subject to year-end
 * carry-forward — they live and die by `lotExpiresOn`.
 */
@Injectable()
export class CompOffService {
  private readonly logger = new Logger(CompOffService.name);

  constructor(
    @InjectModel(LeaveLedger.name)
    private readonly ledgerModel: Model<LeaveLedger>,
    private readonly ledgerService: LeaveLedgerService,
  ) {}

  /** Credit one comp-off lot, earned by working `sourceWorkDate`. */
  async creditCompOff(input: CreditCompOffInput): Promise<LeaveLedger> {
    if (input.quantity <= 0) {
      throw new BadRequestException('Comp-off credit quantity must be positive');
    }
    const year = input.sourceWorkDate.getUTCFullYear();
    const lotExpiresOn = new Date(input.sourceWorkDate.getTime() + input.validityDays * DAY_MS);
    return this.ledgerService.appendEntry({
      workspaceId: new Types.ObjectId(input.workspaceId),
      teamMemberId: new Types.ObjectId(input.teamMemberId),
      leaveTypeId: new Types.ObjectId(input.compOffLeaveTypeId),
      year,
      entryType: 'comp_off_credit',
      quantity: input.quantity,
      effectiveDate: input.sourceWorkDate,
      sourceRef: input.sourceRef,
      actorUserId: input.actorUserId ?? null,
      reason: `Comp-off earned for work on ${input.sourceWorkDate.toISOString().slice(0, 10)}`,
      lotExpiresOn,
      lotRemaining: input.quantity,
      sourceWorkDate: input.sourceWorkDate,
    });
  }

  /**
   * Consume `quantity` comp-off days, oldest-expiry-first. Decrements each
   * drawn lot's `lotRemaining` and posts a `usage` entry in the lot's earn
   * year. Throws when the non-expired lots cannot cover the request.
   */
  async consumeCompOffFifo(input: ConsumeCompOffInput): Promise<ConsumeCompOffResult> {
    if (input.quantity <= 0) {
      throw new BadRequestException('Comp-off consume quantity must be positive');
    }
    const workspaceId = new Types.ObjectId(input.workspaceId);
    const teamMemberId = new Types.ObjectId(input.teamMemberId);
    const leaveTypeId = new Types.ObjectId(input.compOffLeaveTypeId);

    const lotDocs = await this.ledgerModel
      .find({
        workspaceId,
        teamMemberId,
        leaveTypeId,
        entryType: 'comp_off_credit',
        lotExpiresOn: { $gt: input.asOf },
        lotRemaining: { $gt: 0 },
      })
      .sort({ lotExpiresOn: 1 })
      .exec();

    const lots: CompOffLot[] = lotDocs.map((d) => ({
      ledgerEntryId: String(d._id),
      year: d.year,
      lotRemaining: d.lotRemaining ?? 0,
    }));

    const { allocations, shortfall } = allocateFifo(lots, input.quantity);
    if (shortfall > 0) {
      throw new BadRequestException(`Insufficient comp-off balance — short by ${shortfall} day(s)`);
    }

    for (const alloc of allocations) {
      await this.ledgerModel
        .updateOne(
          { _id: new Types.ObjectId(alloc.ledgerEntryId) },
          { $inc: { lotRemaining: -alloc.consumed } },
        )
        .exec();
      await this.ledgerService.appendEntry({
        workspaceId,
        teamMemberId,
        leaveTypeId,
        year: alloc.year,
        entryType: 'usage',
        quantity: -alloc.consumed,
        effectiveDate: input.asOf,
        sourceRef: input.sourceRef,
        actorUserId: input.actorUserId ?? null,
        reason: `Comp-off used from ${alloc.year} lot`,
      });
    }

    return { consumed: input.quantity, lots: allocations };
  }

  /** Total remaining days across a member's non-expired comp-off lots. */
  async availableForConsumption(input: {
    workspaceId: string;
    teamMemberId: string;
    compOffLeaveTypeId: string;
    asOf: Date;
  }): Promise<number> {
    const lots = await this.ledgerModel
      .find({
        workspaceId: new Types.ObjectId(input.workspaceId),
        teamMemberId: new Types.ObjectId(input.teamMemberId),
        leaveTypeId: new Types.ObjectId(input.compOffLeaveTypeId),
        entryType: 'comp_off_credit',
        lotExpiresOn: { $gt: input.asOf },
        lotRemaining: { $gt: 0 },
      })
      .select('lotRemaining')
      .lean()
      .exec();
    return lots.reduce((sum, lot) => sum + (lot.lotRemaining ?? 0), 0);
  }

  /**
   * A member's active comp-off lots — non-expired, with days still remaining,
   * oldest-expiry first (the order FIFO consumption draws them). Powers the
   * worker comp-off self-service balance view (L6b).
   */
  async listActiveLots(input: {
    workspaceId: string;
    teamMemberId: string;
    compOffLeaveTypeId: string;
    asOf: Date;
  }): Promise<CompOffLotView[]> {
    const lots = await this.ledgerModel
      .find({
        workspaceId: new Types.ObjectId(input.workspaceId),
        teamMemberId: new Types.ObjectId(input.teamMemberId),
        leaveTypeId: new Types.ObjectId(input.compOffLeaveTypeId),
        entryType: 'comp_off_credit',
        lotExpiresOn: { $gt: input.asOf },
        lotRemaining: { $gt: 0 },
      })
      .sort({ lotExpiresOn: 1 })
      .lean()
      .exec();
    return lots.map((d) => ({
      ledgerEntryId: String(d._id),
      sourceWorkDate: (d.sourceWorkDate ?? d.effectiveDate).toISOString(),
      creditedDays: d.quantity,
      remainingDays: d.lotRemaining ?? 0,
      expiresOn: (d.lotExpiresOn ?? d.effectiveDate).toISOString(),
    }));
  }

  /**
   * Reverse a prior FIFO consumption — re-credits each drawn lot's
   * `lotRemaining` and posts a `usage_reversal` per lot. Driven by the
   * `compOffConsumption` record snapshotted on the leave request, so the exact
   * lots are restored when an approved comp-off leave is withdrawn.
   */
  async reverseConsumption(input: {
    workspaceId: string;
    teamMemberId: string;
    compOffLeaveTypeId: string;
    allocations: Array<{ lotLedgerEntryId: string; year: number; consumed: number }>;
    sourceRef: { kind: LeaveLedgerSourceKind; id: Types.ObjectId | null };
    actorUserId?: Types.ObjectId | null;
  }): Promise<void> {
    const workspaceId = new Types.ObjectId(input.workspaceId);
    const teamMemberId = new Types.ObjectId(input.teamMemberId);
    const leaveTypeId = new Types.ObjectId(input.compOffLeaveTypeId);
    const now = new Date();
    for (const alloc of input.allocations) {
      if (alloc.consumed <= 0) continue;
      await this.ledgerModel
        .updateOne(
          { _id: new Types.ObjectId(alloc.lotLedgerEntryId) },
          { $inc: { lotRemaining: alloc.consumed } },
        )
        .exec();
      await this.ledgerService.appendEntry({
        workspaceId,
        teamMemberId,
        leaveTypeId,
        year: alloc.year,
        entryType: 'usage_reversal',
        quantity: alloc.consumed,
        effectiveDate: now,
        sourceRef: input.sourceRef,
        actorUserId: input.actorUserId ?? null,
        reason: `Comp-off leave withdrawn — ${alloc.consumed} day(s) restored to the ${alloc.year} lot`,
      });
    }
  }

  /** Expire every comp-off lot past its validity — posts `comp_off_expiry`. */
  async expireCompOffLots(asOf: Date = new Date()): Promise<CompOffExpiryResult> {
    const errors: string[] = [];
    let lotsExpired = 0;
    let daysExpired = 0;

    const expired = await this.ledgerModel
      .find({
        entryType: 'comp_off_credit',
        lotExpiresOn: { $lte: asOf },
        lotRemaining: { $gt: 0 },
      })
      .limit(500)
      .exec();

    for (const lot of expired) {
      const remaining = lot.lotRemaining ?? 0;
      if (remaining <= 0) continue;
      try {
        await this.ledgerService.appendEntry({
          workspaceId: lot.workspaceId,
          teamMemberId: lot.teamMemberId,
          leaveTypeId: lot.leaveTypeId,
          year: lot.year,
          entryType: 'comp_off_expiry',
          quantity: -remaining,
          effectiveDate: lot.lotExpiresOn ?? asOf,
          sourceRef: { kind: 'cron', id: null },
          reason: `Comp-off lot expired (${remaining} day(s) unused)`,
        });
        await this.ledgerModel.updateOne({ _id: lot._id }, { $set: { lotRemaining: 0 } }).exec();
        lotsExpired++;
        daysExpired += remaining;
      } catch (err) {
        errors.push(`lot ${String(lot._id)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { lotsExpired, daysExpired, errors };
  }
}
