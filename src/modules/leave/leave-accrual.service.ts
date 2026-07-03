import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LeaveType } from './schemas/leave-type.schema';
import { LeaveLedger } from './schemas/leave-ledger.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { LeaveLedgerService, LeaveBucket } from './leave-ledger.service';
import {
  prorateUpfrontCredit,
  periodsForYear,
  isPeriodAccruable,
  proratePeriodCredit,
} from './leave-accrual.util';

const DAY_MS = 86_400_000;

export interface AccrualRunResult {
  workspacesScanned: number;
  membersScanned: number;
  entriesPosted: number;
  errors: string[];
}

/**
 * The L2a accrual engine — posts `accrual` ledger entries.
 *
 * - `upfront_annual` types (CL/SL) → one credit per member per leave year,
 *   prorated by join month.
 * - `periodic_accrual` types (EL) → one credit per completed period, prorated
 *   for the first active period, skipped while the live balance is at the
 *   `accrualCap` ceiling.
 *
 * Idempotent: a credit is posted only when no entry already covers that year
 * (upfront) / period (periodic), so the daily cron can re-run safely.
 *
 * Leave year = calendar year (Jan–Dec). A per-workspace leave-year start is a
 * later enhancement.
 */
@Injectable()
export class LeaveAccrualService {
  private readonly logger = new Logger(LeaveAccrualService.name);

  constructor(
    @InjectModel(LeaveType.name)
    private readonly leaveTypeModel: Model<LeaveType>,
    @InjectModel(TeamMember.name)
    private readonly memberModel: Model<TeamMember>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(LeaveLedger.name)
    private readonly ledgerModel: Model<LeaveLedger>,
    private readonly ledgerService: LeaveLedgerService,
  ) {}

  /** Accrue for every workspace — entry point for the daily cron. */
  async accrueAllWorkspaces(asOf: Date = new Date()): Promise<AccrualRunResult> {
    const result: AccrualRunResult = {
      workspacesScanned: 0,
      membersScanned: 0,
      entriesPosted: 0,
      errors: [],
    };

    const workspaces = await this.workspaceModel.find({}, { _id: 1 }).lean().exec();

    for (const ws of workspaces) {
      result.workspacesScanned++;
      const workspaceId = String(ws._id);
      try {
        const wsResult = await this.accrueForWorkspace(workspaceId, asOf);
        result.membersScanned += wsResult.membersScanned;
        result.entriesPosted += wsResult.entriesPosted;
        result.errors.push(...wsResult.errors);
      } catch (err) {
        result.errors.push(
          `workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return result;
  }

  /** Accrue for every active member × accruing leave type in one workspace. */
  async accrueForWorkspace(
    workspaceId: string,
    asOf: Date = new Date(),
  ): Promise<{ membersScanned: number; entriesPosted: number; errors: string[] }> {
    const errors: string[] = [];
    let entriesPosted = 0;
    const wsObjectId = new Types.ObjectId(workspaceId);

    const leaveTypes = await this.leaveTypeModel
      .find({ workspaceId: wsObjectId, isActive: true })
      .exec();
    const accruing = leaveTypes.filter((lt) => lt.accrualRule.mode !== 'none');
    if (accruing.length === 0) {
      return { membersScanned: 0, entriesPosted: 0, errors };
    }

    const members = await this.memberModel
      .find({ workspaceId: wsObjectId, isActive: true, isDeleted: false })
      .select('_id dateOfJoining')
      .lean()
      .exec();

    for (const member of members) {
      const teamMemberId = String(member._id);
      const dateOfJoining = member.dateOfJoining ?? null;
      for (const leaveType of accruing) {
        try {
          entriesPosted += await this.accrueForMember(
            workspaceId,
            teamMemberId,
            dateOfJoining,
            leaveType,
            asOf,
          );
        } catch (err) {
          errors.push(
            `member ${teamMemberId} type ${leaveType.code}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    return { membersScanned: members.length, entriesPosted, errors };
  }

  /**
   * Accrue one member × one leave type for the calendar year of `asOf`.
   * Returns the number of ledger entries posted (0 if nothing was due).
   */
  async accrueForMember(
    workspaceId: string,
    teamMemberId: string,
    dateOfJoining: Date | null,
    leaveType: LeaveType,
    asOf: Date,
  ): Promise<number> {
    const rule = leaveType.accrualRule;
    if (rule.mode === 'none') return 0;

    const year = asOf.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const bucket: LeaveBucket = {
      workspaceId: new Types.ObjectId(workspaceId),
      teamMemberId: new Types.ObjectId(teamMemberId),
      leaveTypeId: new Types.ObjectId(String(leaveType._id)),
      year,
    };

    // Accrual window: from year start, or join date if later.
    let accrualStart =
      dateOfJoining && dateOfJoining.getTime() > yearStart.getTime() ? dateOfJoining : yearStart;

    // Eligibility gate — accrual starts only after the waiting period.
    if (rule.eligibleAfterDays > 0 && dateOfJoining) {
      const eligibleOn = new Date(dateOfJoining.getTime() + rule.eligibleAfterDays * DAY_MS);
      if (eligibleOn.getTime() > asOf.getTime()) return 0; // not eligible yet
      if (eligibleOn.getTime() > accrualStart.getTime()) {
        accrualStart = eligibleOn;
      }
    }

    if (rule.mode === 'upfront_annual') {
      return this.accrueUpfront(bucket, leaveType, dateOfJoining, year, accrualStart);
    }
    return this.accruePeriodic(bucket, leaveType, asOf, accrualStart);
  }

  /** One prorated annual credit, posted at most once per member per year. */
  private async accrueUpfront(
    bucket: LeaveBucket,
    leaveType: LeaveType,
    dateOfJoining: Date | null,
    year: number,
    accrualStart: Date,
  ): Promise<number> {
    const alreadyCredited = await this.ledgerModel
      .countDocuments({ ...bucket, entryType: 'accrual' })
      .exec();
    if (alreadyCredited > 0) return 0;

    const qty = prorateUpfrontCredit(leaveType.accrualRule.annualQuantity, dateOfJoining, year);
    if (qty <= 0) return 0;

    await this.ledgerService.appendEntry({
      ...bucket,
      entryType: 'accrual',
      quantity: qty,
      effectiveDate: accrualStart,
      sourceRef: { kind: 'cron', id: null },
      reason: `Annual ${leaveType.code} credit`,
    });
    return 1;
  }

  /** One credit per completed, not-yet-posted period — capped by `accrualCap`. */
  private async accruePeriodic(
    bucket: LeaveBucket,
    leaveType: LeaveType,
    asOf: Date,
    accrualStart: Date,
  ): Promise<number> {
    const rule = leaveType.accrualRule;
    const rate = rule.rate ?? 0;
    const frequency = rule.frequency ?? 'monthly';
    if (rate <= 0) return 0;

    const posted = await this.ledgerModel
      .find({ ...bucket, entryType: 'accrual' })
      .select('effectiveDate')
      .lean()
      .exec();
    const postedTimes = new Set(posted.map((e) => e.effectiveDate.getTime()));

    let count = 0;
    for (const period of periodsForYear(bucket.year, frequency)) {
      if (!isPeriodAccruable(period, asOf, accrualStart)) continue;
      if (postedTimes.has(period.start.getTime())) continue;

      // Accrual cap — skip while the live balance is at/above the ceiling.
      if (rule.accrualCap != null) {
        const balance = await this.ledgerService.getBalance(bucket);
        if (balance && balance.available >= rule.accrualCap) continue;
      }

      const qty = proratePeriodCredit(rate, period, accrualStart);
      if (qty <= 0) continue;

      await this.ledgerService.appendEntry({
        ...bucket,
        entryType: 'accrual',
        quantity: qty,
        effectiveDate: period.start,
        sourceRef: { kind: 'cron', id: null },
        reason: `${leaveType.code} accrual ${period.key}`,
      });
      count++;
    }
    return count;
  }
}
