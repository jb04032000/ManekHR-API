/**
 * CashLedgerService - Phase 3C: Daily-Wage Running Ledger (baki/udhaar).
 *
 * WHAT THIS IS:
 *   A lightweight per-worker running account for daily-wage and piece-rate
 *   karigars in textile SMBs. The owner records:
 *     - EARNINGS (wages owed) as credits to the worker.
 *     - DRAWS (cash advances) as debits from the worker's future wages.
 *   A periodic SETTLEMENT pays out the net balance.
 *
 * WHY IT IS DISTINCT FROM AdvanceRecoveryPlan:
 *   AdvanceRecoveryPlan = formal monthly-salary advance with an installment
 *   schedule, recovered over months from payroll. Requires a salary record.
 *   Suited for salaried employees.
 *
 *   CashLedgerEntry = informal daily cash flow. No salary record required.
 *   A karigar gets Rs 200 on Tuesday before any monthly salary exists. This
 *   service handles that pattern. The two systems are intentionally separate
 *   and use different MongoDB collections. Do NOT route daily-wage draws
 *   through AdvanceRecoveryPlan.
 *
 * RUNNING BALANCE:
 *   balance = SUM(earning amounts) - SUM(draw amounts) - SUM(settlement amounts)
 *   'adjustment' entries add positive or negative amounts (corrections).
 *   Positive balance = owner owes the worker (baki).
 *   Negative balance = worker has overdrawn (udhaar).
 *
 * SETTLEMENT + MINIMUM-WAGE FLAG:
 *   settle() computes the net owed for a worker up to a date, creates a
 *   settlement entry, and marks covered entries with settledInEntryId. It
 *   also checks whether the total earned in the period falls below the
 *   applicable minimum wage (Phase 1 min-wage data from PayrollConfig and
 *   per-member TeamMember.minimumWageMonthlyOverride). This is a WARNING
 *   flag only, not a hard block; surfaced prominently in the UI.
 *
 * RBAC:
 *   Writes: EDIT all + dailyWageLedger feature flag.
 *   Reads: VIEW all.
 *
 * Spec: docs/superpowers/specs/advance-loan-epic/phase-3-bonus-commission-ledger.md
 *       section 4C (Gujarati Running Ledger) and
 *       docs/superpowers/specs/advance-loan-epic/phase-3-clarity-and-overview.md
 */

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { CashLedgerEntry, CASH_LEDGER_ENTRY_TYPES } from './schemas/cash-ledger-entry.schema';
import { PayrollConfig } from './schemas/payroll-config.schema';
import { AuditService } from '../audit/audit.service';
import { PostHogService } from '../../common/posthog/posthog.service';
import { AppModule } from '../../common/enums/modules.enum';
import {
  RecordLedgerEntriesDto,
  LedgerQueryDto,
  WorkspaceBalanceQueryDto,
  SettleDto,
} from './dto/cash-ledger.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

function startOfDay(dateStr: string): Date {
  const d = new Date(dateStr);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfDay(dateStr: string): Date {
  const d = new Date(dateStr);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Return shapes
// ---------------------------------------------------------------------------

export interface LedgerEntryRow {
  _id: string;
  teamMemberId: string;
  date: Date;
  type: (typeof CASH_LEDGER_ENTRY_TYPES)[number];
  amount: number;
  note?: string;
  createdBy: string;
  settledInEntryId?: string;
  createdAt?: Date;
  /** Running balance after this entry (computed during list). */
  runningBalance?: number;
}

export interface MemberLedgerResult {
  teamMemberId: string;
  currentBalance: number;
  entries: LedgerEntryRow[];
  total: number;
  page: number;
  limit: number;
}

export interface WorkspaceBalanceRow {
  teamMemberId: string;
  currentBalance: number;
  lastEntryDate?: Date;
  openEarnings: number;
  openDraws: number;
}

export interface WorkspaceBalancesResult {
  rows: WorkspaceBalanceRow[];
}

export interface MinWageFlagDetail {
  flag: boolean;
  effectiveMinWageMonthly: number | null;
  periodEarned: number;
  proratedMinWage: number | null;
  detail?: string;
}

export interface SettleMemberResult {
  teamMemberId: string;
  settled: boolean;
  settledAmount: number;
  settlementEntryId: string;
  entriesMarked: number;
  minimumWageFlag: MinWageFlagDetail;
}

export interface SettleResult {
  results: SettleMemberResult[];
  totalSettled: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CashLedgerService {
  private readonly logger = new Logger(CashLedgerService.name);

  constructor(
    @InjectModel(CashLedgerEntry.name)
    private readonly cashLedgerModel: Model<CashLedgerEntry>,
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
    @InjectModel('TeamMember')
    private readonly teamMemberModel: Model<any>,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  // ---------------------------------------------------------------------------
  // OTel span wrapper (mirrors CommissionService.withCommissionSpan)
  // ---------------------------------------------------------------------------

  private async withLedgerSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const tracer = trace.getTracer('cash-ledger-service');
    return tracer.startActiveSpan(name, async (span) => {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(k, v);
      }
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Feature-flag check
  // ---------------------------------------------------------------------------

  private async assertFeatureEnabled(workspaceId: string): Promise<void> {
    const config = await this.payrollConfigModel
      .findOne({ workspaceId: toObjectId(workspaceId) })
      .lean()
      .exec();
    if (!config?.features?.dailyWageLedger) {
      // Workspace-policy AND-gate (Playbook Pattern 12): return a STRUCTURED deny
      // payload with a code + reason so the FE can show a "turn it on in Settings"
      // message, never a bare 400 string.
      throw new BadRequestException({
        denied: true,
        code: 'DAILY_WAGE_LEDGER_DISABLED',
        reason: 'WORKSPACE_POLICY_DAILY_WAGE_LEDGER_DISABLED',
        message:
          'Daily-wage ledger is not enabled for this workspace. Enable it in Payroll Settings.',
      });
    }
  }

  /**
   * OQ-S5 — block ledger writes against a removed (soft-deleted) member. Uses
   * the already-injected teamMemberModel so no constructor change is needed (the
   * positional unit-test mocks stay valid). Throws 403 MEMBER_OFFBOARDED.
   */
  private async assertMemberWritable(workspaceId: string, teamMemberId: string): Promise<void> {
    const member = await this.teamMemberModel
      .findOne({ _id: toObjectId(teamMemberId), workspaceId: toObjectId(workspaceId) })
      .select('_id isDeleted')
      .lean()
      .exec();
    if (!member || member.isDeleted === true) {
      throw new ForbiddenException({
        code: 'MEMBER_OFFBOARDED',
        message: 'This member has been removed. Their cash ledger is read-only.',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Min-wage resolution (mirrors salary.service.ts pattern, Phase 1)
  // ---------------------------------------------------------------------------

  /**
   * Resolve the effective minimum monthly wage for a member.
   * Priority: TeamMember.minimumWageMonthlyOverride > PayrollConfig.compliance.minimumWageMonthly > null.
   */
  private async resolveMinWage(workspaceId: string, teamMemberId: string): Promise<number | null> {
    const [member, config] = await Promise.all([
      this.teamMemberModel
        .findOne({ _id: toObjectId(teamMemberId), workspaceId: toObjectId(workspaceId) })
        .select('minimumWageMonthlyOverride')
        .lean()
        .exec(),
      this.payrollConfigModel
        .findOne({ workspaceId: toObjectId(workspaceId) })
        .lean()
        .exec(),
    ]);

    const override = (member as any)?.minimumWageMonthlyOverride;
    if (override !== undefined && override !== null) {
      return override as number;
    }
    return config?.compliance?.minimumWageMonthly ?? null;
  }

  // ---------------------------------------------------------------------------
  // recordEntries
  // ---------------------------------------------------------------------------

  /**
   * Bulk-capable create for earning, draw, and adjustment entries.
   * Settlement entries are created only via settle().
   *
   * Validates:
   *   - earning/draw amounts must be > 0.
   *   - adjustment amounts must be non-zero (positive or negative).
   *   - date defaults to today when omitted.
   */
  async recordEntries(
    workspaceId: string,
    dto: RecordLedgerEntriesDto,
    userId: string,
  ): Promise<{ created: number; entryIds: string[] }> {
    return this.withLedgerSpan(
      'cashLedger.recordEntries',
      { workspaceId, count: dto.entries.length },
      async () => {
        await this.assertFeatureEnabled(workspaceId);

        const entryIds: string[] = [];

        for (const item of dto.entries) {
          if (item.type !== 'adjustment' && item.amount <= 0) {
            throw new BadRequestException(
              `Amount must be > 0 for type '${item.type}'. Member: ${item.teamMemberId}`,
            );
          }
          if (item.type === 'adjustment' && item.amount === 0) {
            throw new BadRequestException(
              `Adjustment amount cannot be 0. Member: ${item.teamMemberId}`,
            );
          }

          // OQ-S5: no new cash-ledger entries against a removed member.
          await this.assertMemberWritable(workspaceId, item.teamMemberId);

          const dateStr = item.date ?? todayStr();
          const entryDate = startOfDay(dateStr);

          const doc = new this.cashLedgerModel({
            workspaceId: toObjectId(workspaceId),
            teamMemberId: toObjectId(item.teamMemberId),
            date: entryDate,
            type: item.type,
            amount: item.amount,
            note: item.note ?? undefined,
            createdBy: toObjectId(userId),
          });

          await doc.save();
          entryIds.push(String(doc._id));

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'cash_ledger_entry',
            entityId: String(doc._id),
            action: 'cash_ledger.entry_created',
            actorId: userId,
            teamMemberId: item.teamMemberId,
            after: {
              type: item.type,
              amount: item.amount,
              date: dateStr,
              note: item.note ?? null,
            },
          });
        }

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.ledger_entry_created',
          properties: {
            workspaceId,
            count: dto.entries.length,
            types: [...new Set(dto.entries.map((e) => e.type))],
          },
        });

        return { created: entryIds.length, entryIds };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // getMemberLedger
  // ---------------------------------------------------------------------------

  /**
   * Return a worker's ledger entries over a date range plus their current
   * running balance (computed from all entries, not just the range).
   *
   * Running balance = SUM(earning) - SUM(draw) - SUM(settlement) + net(adjustment)
   *
   * The full-history balance is computed via an aggregation pipeline and is
   * not limited to the date range filter. The range filter applies only to
   * which entries are returned in the page.
   */
  async getMemberLedger(
    workspaceId: string,
    teamMemberId: string,
    query: LedgerQueryDto,
  ): Promise<MemberLedgerResult> {
    return this.withLedgerSpan(
      'cashLedger.getMemberLedger',
      { workspaceId, teamMemberId },
      async () => {
        const wsId = toObjectId(workspaceId);
        const membId = toObjectId(teamMemberId);

        // Compute the current running balance from all entries (no date filter).
        const balanceResult = await this.computeMemberBalance(wsId, membId);

        // Fetch the paginated entries within the optional date range.
        const page = query.page ?? 1;
        const limit = query.limit ?? 50;
        const skip = (page - 1) * limit;

        const filter: Record<string, unknown> = {
          workspaceId: wsId,
          teamMemberId: membId,
        };

        if (query.fromDate || query.toDate) {
          const dateFilter: Record<string, Date> = {};
          if (query.fromDate) dateFilter.$gte = startOfDay(query.fromDate);
          if (query.toDate) dateFilter.$lte = endOfDay(query.toDate);
          filter.date = dateFilter;
        }

        if (query.type) {
          filter.type = query.type;
        }

        const [entries, total] = await Promise.all([
          this.cashLedgerModel
            .find(filter as any)
            .sort({ date: 1, createdAt: 1 })
            .skip(skip)
            .limit(limit)
            .lean()
            .exec(),
          this.cashLedgerModel.countDocuments(filter as any),
        ]);

        const rows = (entries as any[]).map((e) => ({
          _id: String(e._id),
          teamMemberId: String(e.teamMemberId),
          date: e.date,
          type: e.type,
          amount: e.amount,
          note: e.note,
          createdBy: String(e.createdBy),
          settledInEntryId: e.settledInEntryId ? String(e.settledInEntryId) : undefined,
          createdAt: e.createdAt,
        }));

        return {
          teamMemberId,
          currentBalance: balanceResult,
          entries: rows,
          total,
          page,
          limit,
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // getWorkspaceBalances
  // ---------------------------------------------------------------------------

  /**
   * Per-worker running balance board for the workspace.
   * This is the main daily view: "who do I owe (baki) / who owes me (udhaar)".
   *
   * Returns one row per member who has at least one ledger entry. Each row
   * carries the current balance and open (unsettled) earnings + draws.
   *
   * The balance computation uses the sign convention:
   *   positive = owner owes worker (baki)
   *   negative = worker has overdrawn (udhaar)
   */
  async getWorkspaceBalances(
    workspaceId: string,
    query: WorkspaceBalanceQueryDto,
  ): Promise<WorkspaceBalancesResult> {
    return this.withLedgerSpan('cashLedger.getWorkspaceBalances', { workspaceId }, async () => {
      const wsId = toObjectId(workspaceId);
      const limit = query.limit ?? 100;

      type AggRow = {
        _id: string;
        totalEarning: number;
        totalDraw: number;
        totalSettlement: number;
        netAdjustment: number;
        openEarnings: number;
        openDraws: number;
        lastEntryDate: Date | null;
      };

      const rows = await this.cashLedgerModel
        .aggregate<AggRow>([
          { $match: { workspaceId: wsId } },
          {
            $group: {
              _id: { $toString: '$teamMemberId' },
              totalEarning: {
                $sum: {
                  $cond: [{ $eq: ['$type', 'earning'] }, '$amount', 0],
                },
              },
              totalDraw: {
                $sum: {
                  $cond: [{ $eq: ['$type', 'draw'] }, '$amount', 0],
                },
              },
              totalSettlement: {
                $sum: {
                  $cond: [{ $eq: ['$type', 'settlement'] }, '$amount', 0],
                },
              },
              netAdjustment: {
                $sum: {
                  $cond: [{ $eq: ['$type', 'adjustment'] }, '$amount', 0],
                },
              },
              openEarnings: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$type', 'earning'] },
                        { $eq: [{ $ifNull: ['$settledInEntryId', null] }, null] },
                      ],
                    },
                    '$amount',
                    0,
                  ],
                },
              },
              openDraws: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$type', 'draw'] },
                        { $eq: [{ $ifNull: ['$settledInEntryId', null] }, null] },
                      ],
                    },
                    '$amount',
                    0,
                  ],
                },
              },
              lastEntryDate: { $max: '$date' },
            },
          },
          {
            $addFields: {
              currentBalance: {
                $add: [
                  { $subtract: ['$totalEarning', { $add: ['$totalDraw', '$totalSettlement'] }] },
                  '$netAdjustment',
                ],
              },
            },
          },
          ...(query.filter !== 'all' ? [{ $match: { currentBalance: { $ne: 0 } } }] : []),
          { $sort: { lastEntryDate: -1 } },
          { $limit: limit },
        ])
        .exec();

      return {
        rows: rows.map((r) => ({
          teamMemberId: r._id,
          currentBalance: r.totalEarning - r.totalDraw - r.totalSettlement + r.netAdjustment,
          lastEntryDate: r.lastEntryDate ?? undefined,
          openEarnings: r.openEarnings,
          openDraws: r.openDraws,
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // settle
  // ---------------------------------------------------------------------------

  /**
   * Settle one or many workers up to a cutoff date.
   *
   * For each worker:
   *   1. Aggregate open (unsettled) earning and draw entries up to upToDate.
   *   2. Compute net = sum(earning) - sum(draw). This is what the owner pays.
   *   3. Create a settlement entry with the net amount.
   *   4. Mark the covered entries with settledInEntryId.
   *   5. Run the minimum-wage check: if total earned in the period / days
   *      worked is below the applicable minimum wage (pro-rated), set
   *      minimumWageFlag=true with detail. This is a WARNING, not a block.
   *
   * If a worker has no open entries to settle, they are skipped with
   * settled=false in the results (not an error).
   *
   * Minimum-wage pro-ration:
   *   The spec asks for the period's minimum wage check. Here we use a simple
   *   daily pro-ration: proratedMinWage = (minimumWageMonthly / 30) * distinctDays.
   *   distinctDays = count of distinct calendar dates with earning entries in
   *   the open unsettled window. This mirrors how Phase 1 handles daily-rate
   *   minimum-wage floor checks for piece-rate workers.
   */
  async settle(workspaceId: string, dto: SettleDto, userId: string): Promise<SettleResult> {
    return this.withLedgerSpan(
      'cashLedger.settle',
      { workspaceId, memberCount: dto.teamMemberIds.length },
      async () => {
        await this.assertFeatureEnabled(workspaceId);

        const upToDate = endOfDay(dto.upToDate ?? todayStr());
        const wsId = toObjectId(workspaceId);
        const results: SettleMemberResult[] = [];
        let totalSettled = 0;

        for (const memberId of dto.teamMemberIds) {
          const memberResult = await this.settleMember(
            wsId,
            workspaceId,
            memberId,
            upToDate,
            dto.note ?? undefined,
            userId,
          );
          results.push(memberResult);
          totalSettled += memberResult.settledAmount;
        }

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'cash_ledger_settlement',
          entityId: workspaceId,
          action: 'cash_ledger.batch_settled',
          actorId: userId,
          after: {
            memberCount: dto.teamMemberIds.length,
            totalSettled,
            upToDate: upToDate.toISOString(),
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.ledger_settled',
          properties: {
            workspaceId,
            memberCount: dto.teamMemberIds.length,
            totalSettled,
          },
        });

        return { results, totalSettled };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Private: settle one member
  // ---------------------------------------------------------------------------

  private async settleMember(
    wsId: Types.ObjectId,
    workspaceId: string,
    memberId: string,
    upToDate: Date,
    note: string | undefined,
    userId: string,
  ): Promise<SettleMemberResult> {
    const membObjId = toObjectId(memberId);

    // Find all open (unsettled) earning and draw entries up to upToDate.
    const openEntries = await this.cashLedgerModel
      .find({
        workspaceId: wsId,
        teamMemberId: membObjId,
        type: { $in: ['earning', 'draw'] },
        settledInEntryId: { $exists: false },
        date: { $lte: upToDate },
      })
      .lean()
      .exec();

    if (openEntries.length === 0) {
      return {
        teamMemberId: memberId,
        settled: false,
        settledAmount: 0,
        settlementEntryId: '',
        entriesMarked: 0,
        minimumWageFlag: {
          flag: false,
          effectiveMinWageMonthly: null,
          periodEarned: 0,
          proratedMinWage: null,
        },
      };
    }

    let totalEarned = 0;
    let totalDrawn = 0;
    const entryIds: Types.ObjectId[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const e of openEntries as Array<Record<string, any>>) {
      if (e['type'] === 'earning') totalEarned += e['amount'] as number;

      if (e['type'] === 'draw') totalDrawn += e['amount'] as number;

      entryIds.push(toObjectId(String(e['_id'])));
    }

    const netOwed = totalEarned - totalDrawn;
    // Net can be negative (worker owes; owner still records the settlement
    // but the amount paid can be 0 in that case - only pay out positive amounts).
    const settlementAmount = Math.max(0, netOwed);

    // Compute minimum-wage flag using Phase 1 data.

    const minWageFlag = await this.computeMinWageFlag(
      workspaceId,
      memberId,
      openEntries as Array<Record<string, any>>,
      totalEarned,
    );

    // Create the settlement entry.
    const settlementDoc = new this.cashLedgerModel({
      workspaceId: wsId,
      teamMemberId: membObjId,
      date: new Date(),
      type: 'settlement',
      amount: settlementAmount,
      note: note ?? undefined,
      createdBy: toObjectId(userId),
    });
    await settlementDoc.save();
    const settlementId = toObjectId(String(settlementDoc._id));

    // Mark covered entries as settled.
    await this.cashLedgerModel.updateMany(
      { _id: { $in: entryIds } },
      { $set: { settledInEntryId: settlementId } },
    );

    await this.auditService.logEvent({
      workspaceId,
      module: AppModule.SALARY,
      entityType: 'cash_ledger_entry',
      entityId: String(settlementDoc._id),
      action: 'cash_ledger.settled',
      actorId: userId,
      teamMemberId: memberId,
      after: {
        settlementAmount,
        netOwed,
        totalEarned,
        totalDrawn,
        entriesMarked: entryIds.length,
        minimumWageFlag: minWageFlag.flag,
      },
    });

    return {
      teamMemberId: memberId,
      settled: true,
      settledAmount: settlementAmount,
      settlementEntryId: String(settlementDoc._id),
      entriesMarked: entryIds.length,
      minimumWageFlag: minWageFlag,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: minimum-wage flag computation
  // ---------------------------------------------------------------------------

  /**
   * Check if the total earned in the period falls below the applicable minimum
   * wage pro-rated to the working days.
   *
   * Pro-ration: proratedMinWage = (minimumWageMonthly / 30) * distinctEarningDays.
   * This uses 30 as the divisor (standard daily-rate basis for unskilled
   * daily-wage workers in Indian labour law) regardless of actual month length.
   *
   * This is a WARNING flag. It is never a hard block.
   */

  private async computeMinWageFlag(
    workspaceId: string,
    memberId: string,
    openEntries: Array<Record<string, any>>,
    totalEarned: number,
  ): Promise<MinWageFlagDetail> {
    const minWageMonthly = await this.resolveMinWage(workspaceId, memberId);

    if (minWageMonthly === null) {
      return {
        flag: false,
        effectiveMinWageMonthly: null,
        periodEarned: totalEarned,
        proratedMinWage: null,
        detail: 'Minimum wage not configured; floor check skipped.',
      };
    }

    // Count distinct calendar dates where earnings were recorded.
    const earningDates = new Set<string>();
    for (const e of openEntries) {
      if (e.type === 'earning') {
        earningDates.add(new Date(e.date).toISOString().slice(0, 10));
      }
    }
    const distinctDays = earningDates.size || 1;

    const proratedMinWage = Math.round((minWageMonthly / 30) * distinctDays * 100) / 100;
    const flag = totalEarned < proratedMinWage;

    return {
      flag,
      effectiveMinWageMonthly: minWageMonthly,
      periodEarned: totalEarned,
      proratedMinWage,
      detail: flag
        ? `Total earned in period (Rs.${totalEarned}) is below the pro-rated minimum wage ` +
          `(Rs.${proratedMinWage} = Rs.${minWageMonthly}/month / 30 x ${distinctDays} days). ` +
          'Confirm with the worker and your compliance team before settling.'
        : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: compute balance for a single member (used by getMemberLedger)
  // ---------------------------------------------------------------------------

  private async computeMemberBalance(
    wsId: Types.ObjectId,
    membId: Types.ObjectId,
  ): Promise<number> {
    type BalRow = {
      _id: null;
      totalEarning: number;
      totalDraw: number;
      totalSettlement: number;
      netAdjustment: number;
    };
    const [row] = await this.cashLedgerModel
      .aggregate<BalRow>([
        { $match: { workspaceId: wsId, teamMemberId: membId } },
        {
          $group: {
            _id: null,
            totalEarning: {
              $sum: { $cond: [{ $eq: ['$type', 'earning'] }, '$amount', 0] },
            },
            totalDraw: {
              $sum: { $cond: [{ $eq: ['$type', 'draw'] }, '$amount', 0] },
            },
            totalSettlement: {
              $sum: { $cond: [{ $eq: ['$type', 'settlement'] }, '$amount', 0] },
            },
            netAdjustment: {
              $sum: { $cond: [{ $eq: ['$type', 'adjustment'] }, '$amount', 0] },
            },
          },
        },
      ])
      .exec();

    if (!row) return 0;
    return row.totalEarning - row.totalDraw - row.totalSettlement + row.netAdjustment;
  }

  // ---------------------------------------------------------------------------
  // getSingleEntry (for update/delete)
  // ---------------------------------------------------------------------------

  async getSingleEntry(workspaceId: string, entryId: string): Promise<CashLedgerEntry> {
    const entry = await this.cashLedgerModel
      .findOne({
        _id: toObjectId(entryId),
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!entry) {
      throw new NotFoundException('Cash ledger entry not found');
    }
    return entry;
  }

  // ---------------------------------------------------------------------------
  // updateEntry
  // ---------------------------------------------------------------------------

  /**
   * Correct an open entry: update amount, date, or note.
   * Only earning, draw, and adjustment entries can be updated.
   * Settled entries (settledInEntryId is set) are immutable.
   */
  async updateEntry(
    workspaceId: string,
    entryId: string,
    patch: { amount?: number; date?: string; note?: string },
    userId: string,
  ): Promise<CashLedgerEntry> {
    return this.withLedgerSpan('cashLedger.updateEntry', { workspaceId, entryId }, async () => {
      const entry = await this.getSingleEntry(workspaceId, entryId);
      // OQ-S5: a removed member's ledger history is read-only.
      await this.assertMemberWritable(workspaceId, String(entry.teamMemberId));

      if (entry.type === 'settlement') {
        throw new BadRequestException(
          'Settlement entries cannot be edited. Create a new settlement instead.',
        );
      }

      if (entry.settledInEntryId) {
        throw new BadRequestException(
          'This entry has already been settled and cannot be modified.',
        );
      }

      const before = { amount: entry.amount, date: entry.date, note: entry.note };

      if (patch.amount !== undefined) entry.amount = patch.amount;
      if (patch.date !== undefined) entry.date = startOfDay(patch.date);
      if (patch.note !== undefined) entry.note = patch.note;

      await (entry as any).save();

      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.SALARY,
        entityType: 'cash_ledger_entry',
        entityId: entryId,
        action: 'cash_ledger.entry_updated',
        actorId: userId,
        before,
        after: { amount: entry.amount, date: entry.date, note: entry.note },
      });

      return entry;
    });
  }

  // ---------------------------------------------------------------------------
  // softDeleteEntry
  // ---------------------------------------------------------------------------

  /**
   * Soft-delete an entry by creating a counter-adjustment entry of the same
   * magnitude in the opposite direction. The original entry is NOT removed from
   * the database to preserve the audit trail.
   *
   * Settled entries cannot be soft-deleted (would require reversing the settlement).
   */
  async softDeleteEntry(
    workspaceId: string,
    entryId: string,
    userId: string,
  ): Promise<{ deleted: boolean; correctionEntryId: string }> {
    return this.withLedgerSpan('cashLedger.softDeleteEntry', { workspaceId, entryId }, async () => {
      const entry = await this.getSingleEntry(workspaceId, entryId);
      // OQ-S5: a removed member's ledger history is read-only.
      await this.assertMemberWritable(workspaceId, String(entry.teamMemberId));

      if (entry.type === 'settlement') {
        throw new BadRequestException(
          'Settlement entries cannot be deleted. Record a correction adjustment instead.',
        );
      }

      if (entry.settledInEntryId) {
        throw new BadRequestException('This entry has already been settled and cannot be deleted.');
      }

      // Counter-adjustment with the opposite sign to zero out the effect.
      let correctionAmount: number;
      if (entry.type === 'earning') {
        correctionAmount = -entry.amount; // negate: cancels the earning
      } else if (entry.type === 'draw') {
        correctionAmount = entry.amount; // positive adjustment to cancel the draw
      } else {
        // adjustment type: counter it with the opposite sign
        correctionAmount = -entry.amount;
      }

      const correction = new this.cashLedgerModel({
        workspaceId: toObjectId(workspaceId),
        teamMemberId: entry.teamMemberId,
        date: new Date(),
        type: 'adjustment',
        amount: correctionAmount,
        note: `Correction for entry ${entryId} (soft delete)`,
        createdBy: toObjectId(userId),
      });
      await correction.save();

      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.SALARY,
        entityType: 'cash_ledger_entry',
        entityId: entryId,
        action: 'cash_ledger.entry_soft_deleted',
        actorId: userId,
        after: {
          correctionEntryId: String(correction._id),
          correctionAmount,
          originalType: entry.type,
          originalAmount: entry.amount,
        },
      });

      return { deleted: true, correctionEntryId: String(correction._id) };
    });
  }
}
