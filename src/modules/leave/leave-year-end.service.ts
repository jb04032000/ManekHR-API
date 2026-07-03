import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LeaveType } from './schemas/leave-type.schema';
import { LeaveBalance } from './schemas/leave-balance.schema';
import { LeaveLedger } from './schemas/leave-ledger.schema';
import { EncashmentRecord } from './schemas/encashment-record.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { LeaveLedgerService, LeaveBucket } from './leave-ledger.service';
import { computeYearEndDistribution } from './leave-year-end.util';

export interface YearEndRunResult {
  workspacesScanned: number;
  balancesProcessed: number;
  carriedForward: number;
  lapsed: number;
  encashmentRecords: number;
  errors: string[];
}

interface CloseBucketResult {
  processed: boolean;
  carriedForward: number;
  lapsed: number;
  encashmentRecords: number;
}

/**
 * Leave year-end close (L2b). For each member × non-comp-off leave type with a
 * positive closing balance, splits `available` into encashment / carry-forward
 * / lapse per the type's `yearEndRule` and posts the matching ledger entries
 * (a `carry_forward` debit in the closing year, a credit in the new year).
 *
 * Comp-off types are skipped — comp-off lots live and die by `lotExpiresOn`,
 * not the calendar year-end (see `CompOffService`).
 *
 * Idempotent: a bucket already carrying a `carry_forward` / `lapse` /
 * `encashment` entry for the closing year is skipped, so the year-end cron
 * can re-run across its January grace window safely.
 */
@Injectable()
export class LeaveYearEndService {
  private readonly logger = new Logger(LeaveYearEndService.name);

  constructor(
    @InjectModel(LeaveType.name)
    private readonly leaveTypeModel: Model<LeaveType>,
    @InjectModel(LeaveBalance.name)
    private readonly balanceModel: Model<LeaveBalance>,
    @InjectModel(LeaveLedger.name)
    private readonly ledgerModel: Model<LeaveLedger>,
    @InjectModel(EncashmentRecord.name)
    private readonly encashmentModel: Model<EncashmentRecord>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly ledgerService: LeaveLedgerService,
  ) {}

  /** Run the year-end close for `fromYear` across every workspace. */
  async runYearEndAllWorkspaces(fromYear: number): Promise<YearEndRunResult> {
    const result: YearEndRunResult = {
      workspacesScanned: 0,
      balancesProcessed: 0,
      carriedForward: 0,
      lapsed: 0,
      encashmentRecords: 0,
      errors: [],
    };

    const workspaces = await this.workspaceModel.find({}, { _id: 1 }).lean().exec();

    for (const ws of workspaces) {
      result.workspacesScanned++;
      const workspaceId = String(ws._id);
      try {
        const wsResult = await this.runYearEndForWorkspace(workspaceId, fromYear);
        result.balancesProcessed += wsResult.balancesProcessed;
        result.carriedForward += wsResult.carriedForward;
        result.lapsed += wsResult.lapsed;
        result.encashmentRecords += wsResult.encashmentRecords;
        result.errors.push(...wsResult.errors);
      } catch (err) {
        result.errors.push(
          `workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return result;
  }

  /** Run the year-end close for `fromYear` in one workspace. */
  async runYearEndForWorkspace(
    workspaceId: string,
    fromYear: number,
  ): Promise<Omit<YearEndRunResult, 'workspacesScanned'>> {
    const errors: string[] = [];
    let balancesProcessed = 0;
    let carriedForward = 0;
    let lapsed = 0;
    let encashmentRecords = 0;
    const wsObjectId = new Types.ObjectId(workspaceId);

    const leaveTypes = await this.leaveTypeModel.find({ workspaceId: wsObjectId }).exec();
    const typeById = new Map(leaveTypes.map((lt) => [String(lt._id), lt]));

    const balances = await this.balanceModel
      .find({ workspaceId: wsObjectId, year: fromYear })
      .exec();

    for (const balance of balances) {
      const leaveType = typeById.get(String(balance.leaveTypeId));
      if (!leaveType) continue; // orphan balance — no catalogue entry
      if (leaveType.compOff.isCompOff) continue; // comp-off — lot-governed
      if (balance.available <= 0) continue;

      const bucket: LeaveBucket = {
        workspaceId: wsObjectId,
        teamMemberId: balance.teamMemberId,
        leaveTypeId: balance.leaveTypeId,
        year: fromYear,
      };
      try {
        const posted = await this.closeBucket(bucket, balance.available, leaveType);
        if (posted.processed) balancesProcessed++;
        carriedForward += posted.carriedForward;
        lapsed += posted.lapsed;
        encashmentRecords += posted.encashmentRecords;
      } catch (err) {
        errors.push(
          `balance ${String(balance._id)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { balancesProcessed, carriedForward, lapsed, encashmentRecords, errors };
  }

  /** Distribute one bucket's closing balance — idempotent per bucket. */
  private async closeBucket(
    bucket: LeaveBucket,
    available: number,
    leaveType: LeaveType,
  ): Promise<CloseBucketResult> {
    const alreadyClosed = await this.ledgerModel
      .countDocuments({
        ...bucket,
        entryType: { $in: ['carry_forward', 'lapse', 'encashment'] },
      })
      .exec();
    if (alreadyClosed > 0) {
      return { processed: false, carriedForward: 0, lapsed: 0, encashmentRecords: 0 };
    }

    const dist = computeYearEndDistribution(available, leaveType.yearEndRule);
    const closeDate = new Date(Date.UTC(bucket.year, 11, 31));
    let encashmentRecords = 0;

    if (dist.encashed > 0) {
      const entry = await this.ledgerService.appendEntry({
        ...bucket,
        entryType: 'encashment',
        quantity: -dist.encashed,
        effectiveDate: closeDate,
        sourceRef: { kind: 'cron', id: null },
        reason: `Year-end ${leaveType.code} encashment (${bucket.year})`,
      });
      await this.encashmentModel.create({
        workspaceId: bucket.workspaceId,
        teamMemberId: bucket.teamMemberId,
        leaveTypeId: bucket.leaveTypeId,
        year: bucket.year,
        days: dist.encashed,
        trigger: 'annual',
        status: 'pending',
        sourceLedgerEntryId: new Types.ObjectId(String(entry._id)),
      });
      encashmentRecords = 1;
    }

    if (dist.carriedForward > 0) {
      // Debit the closing year …
      await this.ledgerService.appendEntry({
        ...bucket,
        entryType: 'carry_forward',
        quantity: -dist.carriedForward,
        effectiveDate: closeDate,
        sourceRef: { kind: 'cron', id: null },
        reason: `Carried forward to ${bucket.year + 1}`,
      });
      // … and credit the new year.
      await this.ledgerService.appendEntry({
        ...bucket,
        year: bucket.year + 1,
        entryType: 'carry_forward',
        quantity: dist.carriedForward,
        effectiveDate: new Date(Date.UTC(bucket.year + 1, 0, 1)),
        sourceRef: { kind: 'cron', id: null },
        reason: `Carried forward from ${bucket.year}`,
      });
    }

    if (dist.lapsed > 0) {
      await this.ledgerService.appendEntry({
        ...bucket,
        entryType: 'lapse',
        quantity: -dist.lapsed,
        effectiveDate: closeDate,
        sourceRef: { kind: 'cron', id: null },
        reason: `Year-end lapse (${bucket.year})`,
      });
    }

    return {
      processed: true,
      carriedForward: dist.carriedForward,
      lapsed: dist.lapsed,
      encashmentRecords,
    };
  }
}
