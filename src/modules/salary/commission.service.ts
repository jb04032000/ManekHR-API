/**
 * CommissionService - Phase 3B: structured Commission/Incentive module.
 *
 * SINGLE-LEDGER GUARANTEE:
 *   All commission and incentive money is stored exclusively as
 *   SalaryAdjustment rows with category 'commission' or 'incentive'. This
 *   service creates those rows by delegating to SalaryService.ensureSalaryRecord
 *   and then directly creating a SalaryAdjustment - the same model used by
 *   the Record Payment modal's "Add commission" quick-add path
 *   (salary.service.ts createPaymentLinkedAddition). No parallel collection
 *   holds commission amounts. The CommissionSchedule schema stores only the
 *   RULE for scheduled recurring commissions; the PAID money lives in
 *   SalaryAdjustment exclusively.
 *
 * YTD totals, overview numbers, and the payslip PDF all read from the same
 * SalaryAdjustment rows, so they automatically include both modal-entered and
 * structured-section entries without any deduplication concern.
 *
 * PF / ESI exclusion:
 *   commission and incentive adjustments are marked pfExcluded=true and
 *   esiExcluded=true as metadata. The compliance exports (ECR/ESI) use
 *   baseSalary only and are unaffected. The flags exist for audit display
 *   and payslip annotation.
 *
 * TDS:
 *   No changes needed. Commission/incentive additions flow into netSalary
 *   which is the input to tdsService.computeMonthlyTds. Already correct.
 *
 * Scheduling decision:
 *   The cron auto-fire is implemented in commission-schedule.cron.ts. This
 *   service exposes a disburseSchedule method for the manual "Run now" path
 *   that the cron also calls. Both paths are idempotent: a disbursementLog
 *   entry with the same month+year blocks a second dispatch.
 *
 * Spec: docs/superpowers/specs/advance-loan-epic/phase-3-bonus-commission-ledger.md
 *       section 4B (Commission/Incentive Module)
 */

import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SalaryAdjustment } from './schemas/salary-adjustment.schema';
import { CommissionSchedule, COMMISSION_FREQUENCIES } from './schemas/commission-schedule.schema';
import { PayrollConfig } from './schemas/payroll-config.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { SalaryService } from './salary.service';
import { AuditService } from '../audit/audit.service';
import { PostHogService } from '../../common/posthog/posthog.service';
import { AppModule } from '../../common/enums/modules.enum';
import {
  RecordCommissionEntriesDto,
  CommissionYtdQueryDto,
  ListCommissionEntriesQueryDto,
  CreateCommissionScheduleDto,
  UpdateCommissionScheduleDto,
  DisburseScheduleDto,
  ListSchedulesQueryDto,
} from './dto/commission.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

/**
 * Given a financial year start year (e.g. 2025 for FY 2025-26, Apr-Mar),
 * return the { startMonth, startYear, endMonth, endYear } boundaries.
 */
function fyBoundaries(fyStartYear: number) {
  return {
    startMonth: 4,
    startYear: fyStartYear,
    endMonth: 3,
    endYear: fyStartYear + 1,
  };
}

/**
 * Derive the current Indian FY start year from a date.
 * April 2025 - March 2026 = fyStartYear 2025.
 */
function currentFyStartYear(now: Date = new Date()): number {
  const m = now.getMonth() + 1; // 1-based
  const y = now.getFullYear();
  return m >= 4 ? y : y - 1;
}

/**
 * Advance a (month, year) tuple by a given number of months.
 */
function advanceByMonths(
  month: number,
  year: number,
  count: number,
): { month: number; year: number } {
  let m = month + count;
  let y = year;
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  return { month: m, year: y };
}

// ---------------------------------------------------------------------------
// Return type shapes
// ---------------------------------------------------------------------------

export interface CommissionYtdMemberRow {
  teamMemberId: string;
  teamMemberName: string;
  months: Array<{
    month: number;
    year: number;
    commission: number;
    incentive: number;
    total: number;
  }>;
  totalCommission: number;
  totalIncentive: number;
  grandTotal: number;
}

export interface CommissionYtdResult {
  fyStartYear: number;
  rows: CommissionYtdMemberRow[];
  workspaceTotal: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    @InjectModel(SalaryAdjustment.name)
    private readonly salaryAdjustmentModel: Model<SalaryAdjustment>,
    @InjectModel(CommissionSchedule.name)
    private readonly commissionScheduleModel: Model<CommissionSchedule>,
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
    @InjectModel(TeamMember.name)
    private readonly teamMemberModel: Model<TeamMember>,
    private readonly salaryService: SalaryService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  // ---------------------------------------------------------------------------
  // OTel span wrapper (mirrors LoanService.withLoanSpan)
  // ---------------------------------------------------------------------------

  private async withCommissionSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const tracer = trace.getTracer('commission-service');
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
  // Feature-flag check (commissionTracking)
  // ---------------------------------------------------------------------------

  private async assertCommissionEnabled(workspaceId: string): Promise<void> {
    const config = await this.payrollConfigModel
      .findOneAndUpdate({ workspaceId: toObjectId(workspaceId) }, {}, { upsert: false, new: false })
      .exec();
    if (!config?.features?.commissionTracking) {
      throw new BadRequestException(
        'Commission tracking is not enabled for this workspace. Enable it in Payroll Settings.',
      );
    }
  }

  /**
   * Resolve a set of teamMemberId hex strings to their display names in one
   * query. Mirrors the $lookup-to-TeamMember enrichment used by the salary
   * paginated rows (salary.service.ts) so commission tables can show the
   * member NAME instead of a raw ObjectId. Missing members fall back to
   * 'Unknown employee'.
   */
  private async resolveMemberNames(teamMemberIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(teamMemberIds.filter(Boolean))];
    if (unique.length === 0) return new Map();

    const members = await this.teamMemberModel
      .find({ _id: { $in: unique.map((id) => toObjectId(id)) } })
      .select('_id name')
      .lean()
      .exec();

    const map = new Map<string, string>();
    for (const m of members) {
      map.set(String((m as any)._id), (m as any).name ?? 'Unknown employee');
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // recordCommissionEntries
  // ---------------------------------------------------------------------------

  /**
   * Structured / bulk-capable commission create.
   *
   * Creates one SalaryAdjustment per entry in dto.entries. Each row has
   * category='commission' or 'incentive' (caller-specified per entry),
   * source='manual', and pfExcluded=true / esiExcluded=true.
   *
   * This is the same underlying model used by the Record Payment modal's
   * createPaymentLinkedAddition path. The only differences are source
   * ('manual' vs 'payment_recording') and the absence of a linkedPaymentId.
   * Querying SalaryAdjustment by category captures ALL entries regardless of
   * entry point - single ledger is maintained.
   *
   * Each entry calls ensureSalaryRecord so the salary row is created if absent
   * (identical to how advance-recovery deductions work in salary.service.ts).
   */
  async recordCommissionEntries(
    workspaceId: string,
    dto: RecordCommissionEntriesDto,
    userId: string,
  ): Promise<{ created: number; adjustmentIds: string[] }> {
    return this.withCommissionSpan(
      'commission.recordEntries',
      { workspaceId, month: dto.month, year: dto.year, count: dto.entries.length },
      async () => {
        await this.assertCommissionEnabled(workspaceId);

        const adjustmentIds: string[] = [];

        for (const entry of dto.entries) {
          // Ensure a salary record exists for the target month/year.
          // This mirrors the advance-recovery pattern in salary.service.ts.
          const salary = await this.salaryService.ensureSingleEmployeeRecord(
            workspaceId,
            entry.teamMemberId,
            dto.month,
            dto.year,
            toObjectId(userId),
          );

          const isCommissionCategory =
            entry.category === 'commission' || entry.category === 'incentive';
          // All commission/incentive entries are PF and ESI excluded per the spec.
          const adjustment = new this.salaryAdjustmentModel({
            workspaceId: toObjectId(workspaceId),
            salaryId: toObjectId(String((salary as any)._id)),
            teamMemberId: toObjectId(entry.teamMemberId),
            month: dto.month,
            year: dto.year,
            type: 'addition',
            category: entry.category,
            amount: entry.amount,
            source: 'manual',
            reasonTitle: entry.reasonTitle,
            note: entry.note ?? undefined,
            attachments: [],
            status: 'active',
            pfExcluded: isCommissionCategory,
            esiExcluded: isCommissionCategory,
            createdBy: toObjectId(userId),
          });

          await adjustment.save();
          adjustmentIds.push(String(adjustment._id));

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'salary_adjustment',
            entityId: String(adjustment._id),
            action: 'salary_adjustment.created',
            actorId: userId,
            salaryId: String((salary as any)._id),
            teamMemberId: entry.teamMemberId,
            month: dto.month,
            year: dto.year,
            after: {
              id: String(adjustment._id),
              category: entry.category,
              commissionType: entry.commissionType,
              amount: entry.amount,
              reasonTitle: entry.reasonTitle,
              pfExcluded: true,
              esiExcluded: true,
            },
            meta: {
              source: 'commission_structured',
              commissionType: entry.commissionType,
              reference: entry.reference ?? null,
            },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.commission_entry_created',
            properties: {
              workspaceId,
              teamMemberId: entry.teamMemberId,
              category: entry.category,
              commissionType: entry.commissionType,
              amount: entry.amount,
              month: dto.month,
              year: dto.year,
              source: 'structured',
            },
          });
        }

        // Trigger recalculation so netSalary reflects the new additions.
        // Done in a best-effort block; a recalc failure should not abort the
        // response since the adjustments are already persisted.
        try {
          const uniqueMembers = [...new Set(dto.entries.map((e) => e.teamMemberId))];
          await Promise.all(
            uniqueMembers.map((memberId) =>
              this.salaryService
                .ensureSingleEmployeeRecord(
                  workspaceId,
                  memberId,
                  dto.month,
                  dto.year,
                  toObjectId(userId),
                )
                .catch((recalcErr: unknown) => {
                  const msg = recalcErr instanceof Error ? recalcErr.message : String(recalcErr);
                  this.logger.warn(
                    `Commission recalc failed for member ${memberId} ${dto.month}/${dto.year}: ${msg}`,
                  );
                }),
            ),
          );
        } catch (recalcErr: unknown) {
          const msg = recalcErr instanceof Error ? recalcErr.message : String(recalcErr);
          this.logger.warn(`Commission batch recalc failed: ${msg}`);
        }

        return { created: adjustmentIds.length, adjustmentIds };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // getCommissionYtd
  // ---------------------------------------------------------------------------

  /**
   * Per-member (or workspace-wide) year-to-date commission + incentive totals
   * for an Indian financial year (Apr-Mar).
   *
   * Single source: SalaryAdjustment rows with type='addition', status='active',
   * category in ('commission', 'incentive'). This query returns identical
   * results regardless of whether the entry came from the Record Payment modal,
   * the structured bulk-create, or the scheduled cron dispatch.
   *
   * fyStartYear=2025 covers April 2025 through March 2026.
   */
  async getCommissionYtd(
    workspaceId: string,
    query: CommissionYtdQueryDto,
  ): Promise<CommissionYtdResult> {
    return this.withCommissionSpan('commission.getYtd', { workspaceId }, async () => {
      const fyStartYear = query.fyStartYear ?? currentFyStartYear();
      const fy = fyBoundaries(fyStartYear);
      const wsObjectId = toObjectId(workspaceId);

      // Build the month+year range for the FY.
      // April fyStartYear to March (fyStartYear+1) = 12 months.
      const monthYearConditions: Array<{ month: number; year: number }> = [];
      let m = fy.startMonth;
      let y = fy.startYear;
      for (let i = 0; i < 12; i++) {
        monthYearConditions.push({ month: m, year: y });
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }

      // Aggregate from SalaryAdjustment: the ONLY money store.
      const matchFilter: Record<string, unknown> = {
        workspaceId: wsObjectId,
        type: 'addition',
        status: 'active',
        category: { $in: ['commission', 'incentive'] },
        $or: monthYearConditions,
      };

      if (query.teamMemberId) {
        matchFilter.teamMemberId = toObjectId(query.teamMemberId);
      }

      type AggRow = {
        teamMemberId: string;
        month: number;
        year: number;
        category: string;
        total: number;
      };

      const rows = await this.salaryAdjustmentModel
        .aggregate<AggRow>([
          { $match: matchFilter },
          {
            $group: {
              _id: {
                teamMemberId: '$teamMemberId',
                month: '$month',
                year: '$year',
                category: '$category',
              },
              total: { $sum: '$amount' },
            },
          },
          {
            $project: {
              _id: 0,
              teamMemberId: { $toString: '$_id.teamMemberId' },
              month: '$_id.month',
              year: '$_id.year',
              category: '$_id.category',
              total: 1,
            },
          },
        ])
        .exec();

      // Group into per-member structure.
      const memberMap = new Map<string, CommissionYtdMemberRow>();
      for (const row of rows) {
        if (!memberMap.has(row.teamMemberId)) {
          memberMap.set(row.teamMemberId, {
            teamMemberId: row.teamMemberId,
            teamMemberName: '',
            months: [],
            totalCommission: 0,
            totalIncentive: 0,
            grandTotal: 0,
          });
        }
        const member = memberMap.get(row.teamMemberId);
        if (!member) continue;

        let monthEntry = member.months.find((mx) => mx.month === row.month && mx.year === row.year);
        if (!monthEntry) {
          monthEntry = { month: row.month, year: row.year, commission: 0, incentive: 0, total: 0 };
          member.months.push(monthEntry);
        }

        if (row.category === 'commission') {
          monthEntry.commission += row.total;
          member.totalCommission += row.total;
        } else {
          monthEntry.incentive += row.total;
          member.totalIncentive += row.total;
        }
        monthEntry.total += row.total;
        member.grandTotal += row.total;
      }

      // Sort months chronologically within each member.
      for (const member of memberMap.values()) {
        member.months.sort((a, b) => a.year * 100 + a.month - (b.year * 100 + b.month));
      }

      const result: CommissionYtdMemberRow[] = [...memberMap.values()];

      // Enrich each row with the member display name (single batched query).
      const nameMap = await this.resolveMemberNames(result.map((r) => r.teamMemberId));
      for (const row of result) {
        row.teamMemberName = nameMap.get(row.teamMemberId) ?? 'Unknown employee';
      }

      const workspaceTotal = result.reduce((s, r) => s + r.grandTotal, 0);

      return { fyStartYear, rows: result, workspaceTotal };
    });
  }

  // ---------------------------------------------------------------------------
  // listCommissionEntries
  // ---------------------------------------------------------------------------

  /**
   * List commission/incentive SalaryAdjustment rows matching the filter.
   * Single source: reads only SalaryAdjustment, no join to CommissionSchedule
   * for the monetary rows. The commissionScheduleId field on the adjustment
   * links back when applicable.
   */
  async listCommissionEntries(
    workspaceId: string,
    query: ListCommissionEntriesQueryDto,
  ): Promise<Array<SalaryAdjustment & { teamMemberName: string }>> {
    const filter: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
      type: 'addition',
      status: 'active',
      category: query.category ? query.category : { $in: ['commission', 'incentive'] },
    };

    if (query.teamMemberId) {
      filter.teamMemberId = toObjectId(query.teamMemberId);
    }
    if (query.month !== undefined) {
      filter.month = query.month;
    }
    if (query.year !== undefined) {
      filter.year = query.year;
    }

    const entries = (await this.salaryAdjustmentModel
      .find(filter as any)
      .sort({ year: -1, month: -1, createdAt: -1 })
      .lean()
      .exec()) as unknown as Array<SalaryAdjustment & { teamMemberName?: string }>;

    // Enrich with the member display name so the FE table shows the NAME
    // instead of a raw ObjectId (single batched query; mirrors the salary
    // paginated-rows $lookup pattern).
    const nameMap = await this.resolveMemberNames(
      entries.map((e) => String((e as any).teamMemberId)),
    );
    return entries.map((e) => ({
      ...e,
      teamMemberName: nameMap.get(String((e as any).teamMemberId)) ?? 'Unknown employee',
    }));
  }

  // ---------------------------------------------------------------------------
  // CommissionSchedule CRUD
  // ---------------------------------------------------------------------------

  /** Create a recurring commission schedule rule. */
  async createSchedule(
    workspaceId: string,
    dto: CreateCommissionScheduleDto,
    userId: string,
  ): Promise<CommissionSchedule> {
    return this.withCommissionSpan('commission.createSchedule', { workspaceId }, async () => {
      await this.assertCommissionEnabled(workspaceId);

      const schedule = new this.commissionScheduleModel({
        workspaceId: toObjectId(workspaceId),
        teamMemberId: toObjectId(dto.teamMemberId),
        commissionType: dto.commissionType,
        calcBasis: dto.calcBasis,
        amount: dto.amount,
        frequency: dto.frequency,
        startMonth: dto.startMonth,
        startYear: dto.startYear,
        endMonth: dto.endMonth ?? undefined,
        endYear: dto.endYear ?? undefined,
        note: dto.note ?? undefined,
        status: 'active',
        nextDueMonth: dto.startMonth,
        nextDueYear: dto.startYear,
        disbursementLog: [],
        createdBy: toObjectId(userId),
      });

      await schedule.save();

      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.SALARY,
        entityType: 'commission_schedule',
        entityId: String(schedule._id),
        action: 'commission_schedule.created',
        actorId: userId,
        after: {
          teamMemberId: dto.teamMemberId,
          commissionType: dto.commissionType,
          frequency: dto.frequency,
          amount: dto.amount,
        },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'salary.commission_schedule_created',
        properties: {
          workspaceId,
          scheduleId: String(schedule._id),
          teamMemberId: dto.teamMemberId,
          commissionType: dto.commissionType,
          frequency: dto.frequency,
          amount: dto.amount,
        },
      });

      return schedule;
    });
  }

  /** List schedules with optional filters. */
  listSchedules(workspaceId: string, query: ListSchedulesQueryDto): Promise<CommissionSchedule[]> {
    const filter: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
    };
    if (query.teamMemberId) {
      filter.teamMemberId = toObjectId(query.teamMemberId);
    }
    if (query.status) {
      filter.status = query.status;
    }
    if (query.commissionType) {
      filter.commissionType = query.commissionType;
    }

    return this.commissionScheduleModel
      .find(filter as any)
      .sort({ createdAt: -1 })
      .lean()
      .exec() as unknown as CommissionSchedule[];
  }

  /** Get a single schedule by ID. */
  async getSchedule(workspaceId: string, scheduleId: string): Promise<CommissionSchedule> {
    const schedule = await this.commissionScheduleModel
      .findOne({
        _id: toObjectId(scheduleId),
        workspaceId: toObjectId(workspaceId),
      })
      .lean()
      .exec();

    if (!schedule) {
      throw new NotFoundException('Commission schedule not found');
    }

    return schedule as unknown as CommissionSchedule;
  }

  /** Update amount, dates, note, or status of a schedule. */
  async updateSchedule(
    workspaceId: string,
    scheduleId: string,
    dto: UpdateCommissionScheduleDto,
    userId: string,
  ): Promise<CommissionSchedule> {
    const schedule = await this.commissionScheduleModel
      .findOne({
        _id: toObjectId(scheduleId),
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!schedule) {
      throw new NotFoundException('Commission schedule not found');
    }

    if (schedule.status === 'completed') {
      throw new BadRequestException('Cannot update a completed schedule');
    }

    const before = {
      amount: schedule.amount,
      status: schedule.status,
      commissionType: schedule.commissionType,
    };

    if (dto.amount !== undefined) schedule.amount = dto.amount;
    if (dto.commissionType !== undefined) schedule.commissionType = dto.commissionType;
    if (dto.endMonth !== undefined) schedule.endMonth = dto.endMonth;
    if (dto.endYear !== undefined) schedule.endYear = dto.endYear;
    if (dto.note !== undefined) schedule.note = dto.note;
    if (dto.status !== undefined) schedule.status = dto.status;

    await schedule.save();

    await this.auditService.logEvent({
      workspaceId,
      module: AppModule.SALARY,
      entityType: 'commission_schedule',
      entityId: scheduleId,
      action: 'commission_schedule.updated',
      actorId: userId,
      before,
      after: { amount: schedule.amount, status: schedule.status },
    });

    return schedule;
  }

  /** Soft-delete (marks status='completed'). */
  async deleteSchedule(
    workspaceId: string,
    scheduleId: string,
    userId: string,
  ): Promise<{ deleted: boolean }> {
    const schedule = await this.commissionScheduleModel
      .findOne({
        _id: toObjectId(scheduleId),
        workspaceId: toObjectId(workspaceId),
      })
      .exec();

    if (!schedule) {
      throw new NotFoundException('Commission schedule not found');
    }

    schedule.status = 'completed';
    await schedule.save();

    await this.auditService.logEvent({
      workspaceId,
      module: AppModule.SALARY,
      entityType: 'commission_schedule',
      entityId: scheduleId,
      action: 'commission_schedule.deleted',
      actorId: userId,
      after: { status: 'completed' },
    });

    return { deleted: true };
  }

  // ---------------------------------------------------------------------------
  // disburseSchedule - manual trigger and cron shared path
  // ---------------------------------------------------------------------------

  /**
   * Post a SalaryAdjustment for a due commission schedule period.
   *
   * Idempotency: if a disbursementLog entry already exists for the same
   * month+year, the call is a no-op and returns the existing adjustmentId.
   * This prevents double-posting from cron re-runs or manual re-triggers.
   *
   * The created SalaryAdjustment has:
   *   category: 'commission'
   *   source: 'system' (for cron-triggered), 'manual' for API-triggered
   *   pfExcluded: true, esiExcluded: true
   *   commissionScheduleId: schedule._id (back-link)
   *
   * After posting, nextDueMonth/Year advances to the next due cycle.
   */
  async disburseSchedule(
    workspaceId: string,
    scheduleId: string,
    dto: DisburseScheduleDto,
    userId: string,
    triggeredBySystem = false,
  ): Promise<{ adjustmentId: string; wasAlreadyDisbursed: boolean }> {
    return this.withCommissionSpan(
      'commission.disburseSchedule',
      { workspaceId, scheduleId, month: dto.month, year: dto.year },
      async () => {
        const schedule = await this.commissionScheduleModel
          .findOne({
            _id: toObjectId(scheduleId),
            workspaceId: toObjectId(workspaceId),
          })
          .exec();

        if (!schedule) {
          throw new NotFoundException('Commission schedule not found');
        }

        if (schedule.status !== 'active') {
          throw new BadRequestException(
            `Schedule is ${schedule.status}; only active schedules can be disbursed`,
          );
        }

        // Idempotency: check if already disbursed for this period.
        const alreadyDisbursed = schedule.disbursementLog.find(
          (log) => log.month === dto.month && log.year === dto.year,
        );
        if (alreadyDisbursed) {
          return {
            adjustmentId: String(alreadyDisbursed.adjustmentId),
            wasAlreadyDisbursed: true,
          };
        }

        // Ensure the salary record exists for the target month.
        const salary = await this.salaryService.ensureSingleEmployeeRecord(
          workspaceId,
          String(schedule.teamMemberId),
          dto.month,
          dto.year,
          toObjectId(userId),
        );

        const source = triggeredBySystem ? 'system' : 'manual';
        const reasonTitle = `Commission Schedule - ${dto.month}/${dto.year} (${schedule.commissionType})`;

        const adjustment = new this.salaryAdjustmentModel({
          workspaceId: toObjectId(workspaceId),
          salaryId: toObjectId(String((salary as any)._id)),
          teamMemberId: schedule.teamMemberId,
          month: dto.month,
          year: dto.year,
          type: 'addition',
          category: 'commission',
          amount: schedule.amount,
          source,
          reasonTitle,
          note: schedule.note ?? undefined,
          attachments: [],
          status: 'active',
          pfExcluded: true,
          esiExcluded: true,
          commissionScheduleId: toObjectId(scheduleId),
          createdBy: toObjectId(userId),
        });

        await adjustment.save();
        const adjustmentId = String(adjustment._id);

        // Record in disbursementLog (back-reference only; money is in SalaryAdjustment).
        schedule.disbursementLog.push({
          month: dto.month,
          year: dto.year,
          adjustmentId: toObjectId(adjustmentId),
          amount: schedule.amount,
          disbursedAt: new Date(),
          disbursedBy: toObjectId(userId),
        });

        // Advance nextDueMonth/Year based on frequency.
        const frequencyMonthCount: Record<(typeof COMMISSION_FREQUENCIES)[number], number> = {
          monthly: 1,
          quarterly: 3,
          annual: 12,
        };
        const next = advanceByMonths(dto.month, dto.year, frequencyMonthCount[schedule.frequency]);
        schedule.nextDueMonth = next.month;
        schedule.nextDueYear = next.year;

        // Auto-complete if we've passed the end date.
        if (
          schedule.endYear !== undefined &&
          schedule.endMonth !== undefined &&
          (next.year > schedule.endYear ||
            (next.year === schedule.endYear && next.month > schedule.endMonth))
        ) {
          schedule.status = 'completed';
        }

        await schedule.save();

        await this.auditService.logEvent({
          workspaceId,
          module: AppModule.SALARY,
          entityType: 'commission_schedule',
          entityId: scheduleId,
          action: 'commission_schedule.disbursed',
          actorId: userId,
          after: {
            adjustmentId,
            month: dto.month,
            year: dto.year,
            amount: schedule.amount,
            source,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'salary.commission_schedule_disbursed',
          properties: {
            workspaceId,
            scheduleId,
            adjustmentId,
            month: dto.month,
            year: dto.year,
            amount: schedule.amount,
            triggeredBySystem,
          },
        });

        return { adjustmentId, wasAlreadyDisbursed: false };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Cron-facing: dispatchDueSchedules
  // ---------------------------------------------------------------------------

  /**
   * Called by CommissionScheduleCron on the 1st of each month.
   * Finds all active schedules with nextDueMonth/Year <= current month/year
   * and calls disburseSchedule for each. Safe to re-run (disburseSchedule
   * is idempotent per month+year).
   *
   * Skipped members (e.g. no workspace membership) are handled gracefully:
   * ensureSingleEmployeeRecord throws NotFoundException, which we catch and
   * log as a warning. The schedule remains active for the next cycle.
   */
  async dispatchDueSchedules(
    workspaceId: string,
    currentMonth: number,
    currentYear: number,
    systemUserId: string,
  ): Promise<{ dispatched: number; skipped: number; errors: number }> {
    const wsObjectId = toObjectId(workspaceId);

    const dueSchedules = await this.commissionScheduleModel
      .find({
        workspaceId: wsObjectId,
        status: 'active',
        $or: [
          { nextDueYear: { $lt: currentYear } },
          {
            nextDueYear: currentYear,
            nextDueMonth: { $lte: currentMonth },
          },
        ],
      })
      .exec();

    let dispatched = 0;
    let skipped = 0;
    let errors = 0;

    for (const schedule of dueSchedules) {
      try {
        // OQ-S5 cascade (#8): skip schedules whose member was removed. onMemberRemoved
        // already pauses active schedules, but this is the fail-safe at dispatch
        // time against any active schedule lingering for a soft-deleted member.
        const member = await this.teamMemberModel
          .findById(schedule.teamMemberId)
          .select('_id isDeleted')
          .lean()
          .exec();
        if (!member || member.isDeleted === true) {
          skipped++;
          continue;
        }
        const result = await this.disburseSchedule(
          workspaceId,
          String(schedule._id),
          { month: schedule.nextDueMonth, year: schedule.nextDueYear },
          systemUserId,
          true,
        );
        if (result.wasAlreadyDisbursed) {
          skipped++;
        } else {
          dispatched++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Commission dispatch failed for schedule ${String(schedule._id)} ` +
            `member=${String(schedule.teamMemberId)}: ${msg}`,
        );
        errors++;
      }
    }

    return { dispatched, skipped, errors };
  }
}
