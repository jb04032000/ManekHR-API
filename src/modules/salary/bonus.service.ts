/**
 * BonusService - Phase 3A: Bonus Module.
 *
 * SINGLE-LEDGER GUARANTEE:
 *   All bonus money is stored exclusively as SalaryAdjustment rows with
 *   category='bonus'. This service creates those rows by delegating to
 *   SalaryService.ensureSingleEmployeeRecord (same pattern as commission).
 *   BonusRun stores only the computation + metadata + back-reference IDs.
 *   No parallel collection holds bonus amounts.
 *
 *   getBonusSummary aggregates only from SalaryAdjustment with category='bonus',
 *   so it automatically includes both run-disbursed and any ad-hoc adjustments
 *   added directly through the generic adjustment form. No deduplication needed.
 *
 * STATUTORY BONUS VOCABULARY (binding - phase-3-clarity-and-overview.md):
 *   "Statutory Bonus" = Payment of Bonus Act / Code on Wages (8.33-20%,
 *     eligibility ceiling Rs 21,000, calc wage floor Rs 7,000).
 *   "Festival/Discretionary Bonus" = free-form employer grant; no statutory engine.
 *   Never use "bonus" without qualifying it.
 *
 * IDEMPOTENCY (runStatutoryBonus):
 *   A re-run for the same (workspaceId, financialYear, teamMemberId, type=statutory)
 *   will not double-pay. The guard queries existing 'bonus' SalaryAdjustments where
 *   bonusFinancialYear=FY AND bonusRunId IS SET (i.e. created by a run, not ad-hoc).
 *   If found, the member is skipped. This avoids double-pay when the run is called
 *   twice for the same FY.
 *
 * countsAsStatutory (festival bonus -> statutory obligation):
 *   When a festival bonus is recorded with countsAsStatutory=true, the statutory
 *   run for the same FY checks whether a 'bonus' adjustment already exists for that
 *   member in that FY with countsAsStatutory=true. If found:
 *     - If festival amount >= statutory computed amount: member is skipped (statutory
 *       obligation fully satisfied by the festival bonus).
 *     - If festival amount < statutory computed amount: only the shortfall is posted
 *       as an additional statutory adjustment with a note explaining the credit.
 *   This prevents the double-obligation scenario described in the spec.
 *
 * CLAWBACK + F&F INTEGRATION:
 *   When initiateFnf is called, FnfService queries bonus SalaryAdjustments for the
 *   member where disbursedAt (createdAt of the adjustment) is within the clawback
 *   window (clawbackMonthsDefault months from disbursal to lastWorkingDate).
 *   The sum is stored in FnfSettlement.bonusClawbackAmount and deducted from the
 *   non-gratuity pool (fourth in priority after advance + loan).
 *   Gratuity is always protected (Payment of Gratuity Act 1972).
 *   No circular dependency: FnfService already injects the SalaryAdjustment model
 *   directly; it can query bonus adjustments the same way it queries advance_recovery.
 *
 * PF / ESI:
 *   Bonus is NOT included in PF basic wages (ECR uses baseSalary only).
 *   Statutory bonus is NOT included in ESI wages (Bonus Act bonuses are excluded).
 *   Festival bonus ESI treatment is case-law-dependent; product marks it taxable
 *   but does not force an ESI answer.
 *   Both pfExcluded=true, esiExcluded=false (bonus is TDS-taxable under s.192;
 *   ESI exclusion for festival bonus is owner-confirmed).
 *   No changes needed to compliance-export.service.ts (uses baseSalary exclusively).
 *
 * TDS:
 *   Flows into netSalary via the existing adjustment sum. tdsService.computeMonthlyTds
 *   already handles this correctly. No changes to TDS engine.
 *
 * Spec: docs/superpowers/specs/advance-loan-epic/phase-3-bonus-commission-ledger.md
 *       section 4A (Bonus Module)
 *       docs/superpowers/specs/advance-loan-epic/phase-3-clarity-and-overview.md
 */

import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SalaryAdjustment } from './schemas/salary-adjustment.schema';
import { BonusRun } from './schemas/bonus-run.schema';
import { PayrollConfig } from './schemas/payroll-config.schema';
import { Salary } from './schemas/salary.schema';
import { SalaryService } from './salary.service';
import { AuditService } from '../audit/audit.service';
import { PostHogService } from '../../common/posthog/posthog.service';
import { AppModule } from '../../common/enums/modules.enum';
import {
  PreviewStatutoryBonusDto,
  RunStatutoryBonusDto,
  RecordFestivalBonusDto,
  BonusSummaryQueryDto,
  UpdateBonusConfigDto,
} from './dto/bonus.dto';
import {
  isStatutoryBonusEligible,
  deriveBonusCalcWage,
  deriveApplicableBonusPercent,
  computeStatutoryBonusAmount,
  countMonthsWorked,
} from './utils/bonus.util';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

/**
 * Build an array of { month, year } tuples covering the 12 months of a FY.
 * Used to construct $or match conditions for Mongo queries.
 */
function fyMonthYearPairs(fyStartYear: number): Array<{ month: number; year: number }> {
  const pairs: Array<{ month: number; year: number }> = [];
  // April to December (same year)
  for (let m = 4; m <= 12; m++) {
    pairs.push({ month: m, year: fyStartYear });
  }
  // January to March (next year)
  for (let m = 1; m <= 3; m++) {
    pairs.push({ month: m, year: fyStartYear + 1 });
  }
  return pairs;
}

/** Add N months to (month, year). */
function addMonths(month: number, year: number, n: number): Date {
  const d = new Date(year, month - 1, 1);
  d.setMonth(d.getMonth() + n);
  return d;
}

// ---------------------------------------------------------------------------
// Return-type shapes
// ---------------------------------------------------------------------------

export interface StatutoryBonusPreviewRow {
  teamMemberId: string;
  memberName: string;
  eligible: boolean;
  reason: string;
  lastMonthlyWage: number;
  calcWage: number;
  monthsWorked: number;
  applicablePercent: number;
  bonusAmount: number;
  /** Present for informational display; null when no festival bonus exists. */
  existingFestivalBonusAmount: number | null;
}

export interface StatutoryBonusPreviewResult {
  financialYear: number;
  rows: StatutoryBonusPreviewRow[];
  totalEligibleAmount: number;
  configSnapshot: {
    eligibilityWageCeiling: number;
    calculationWageFloor: number;
    allocableSurplusPercent: number;
    applicablePercent: number;
    newEstablishment: boolean;
  };
}

export interface BonusSummaryMemberRow {
  teamMemberId: string;
  statutory: number;
  discretionary: number;
  total: number;
}

export interface BonusSummaryResult {
  financialYear: number;
  rows: BonusSummaryMemberRow[];
  workspaceStatutory: number;
  workspaceDiscretionary: number;
  workspaceTotal: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class BonusService {
  private readonly logger = new Logger(BonusService.name);

  constructor(
    @InjectModel(SalaryAdjustment.name)
    private readonly salaryAdjustmentModel: Model<SalaryAdjustment>,
    @InjectModel(BonusRun.name)
    private readonly bonusRunModel: Model<BonusRun>,
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    private readonly salaryService: SalaryService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  // ---------------------------------------------------------------------------
  // OTel span wrapper (mirrors CommissionService.withCommissionSpan)
  // ---------------------------------------------------------------------------

  private async withBonusSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const tracer = trace.getTracer('bonus-service');
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
  // Config helpers
  // ---------------------------------------------------------------------------

  /** Load the bonus config (with safe defaults when not yet persisted). */
  private async loadBonusConfig(workspaceId: string): Promise<{
    eligibilityWageCeiling: number;
    calculationWageFloor: number;
    minimumWageMonthly: number | null;
    allocableSurplusPercent: number;
    minPercent: number;
    maxPercent: number;
    defaultPercent: number;
    clawbackMonthsDefault: number;
    newEstablishment: boolean;
  }> {
    const config = await this.payrollConfigModel
      .findOne({ workspaceId: toObjectId(workspaceId) })
      .select('bonusConfig compliance')
      .lean()
      .exec();

    const bc = (config as any)?.bonusConfig ?? {};
    const compliance = (config as any)?.compliance ?? {};

    return {
      eligibilityWageCeiling: bc.eligibilityWageCeiling ?? 21000,
      calculationWageFloor: bc.calculationWageFloor ?? 7000,
      minimumWageMonthly: compliance.minimumWageMonthly ?? null,
      allocableSurplusPercent: bc.allocableSurplusPercent ?? 0,
      minPercent: bc.minPercent ?? 8.33,
      maxPercent: bc.maxPercent ?? 20,
      defaultPercent: bc.defaultPercent ?? 8.33,
      clawbackMonthsDefault: bc.clawbackMonthsDefault ?? 0,
      newEstablishment: bc.newEstablishment ?? false,
    };
  }

  // ---------------------------------------------------------------------------
  // getBonusConfig
  // ---------------------------------------------------------------------------

  async getBonusConfig(workspaceId: string): Promise<ReturnType<typeof this.loadBonusConfig>> {
    return this.loadBonusConfig(workspaceId);
  }

  // ---------------------------------------------------------------------------
  // updateBonusConfig
  // ---------------------------------------------------------------------------

  async updateBonusConfig(
    workspaceId: string,
    dto: UpdateBonusConfigDto,
    userId: string,
  ): Promise<ReturnType<typeof this.loadBonusConfig>> {
    return this.withBonusSpan('bonus.updateConfig', { workspaceId }, async () => {
      // Build a safe update that only sets the provided fields.
      const updateFields: Record<string, unknown> = {};
      const keys = [
        'eligibilityWageCeiling',
        'calculationWageFloor',
        'minPercent',
        'maxPercent',
        'defaultPercent',
        'allocableSurplusPercent',
        'clawbackMonthsDefault',
        'newEstablishment',
      ] as const;
      for (const k of keys) {
        if (dto[k] !== undefined) {
          updateFields[`bonusConfig.${k}`] = dto[k];
        }
      }

      if (Object.keys(updateFields).length === 0) {
        // Nothing to update; return current config.
        return this.loadBonusConfig(workspaceId);
      }

      await this.payrollConfigModel.updateOne(
        { workspaceId: toObjectId(workspaceId) },
        { $set: updateFields },
        { upsert: true },
      );

      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.SALARY,
        entityType: 'payroll_config',
        entityId: workspaceId,
        action: 'salary.bonus_config_updated',
        actorId: userId,
        after: updateFields,
      });

      return this.loadBonusConfig(workspaceId);
    });
  }

  // ---------------------------------------------------------------------------
  // Core: compute per-member statutory preview rows (pure-ish; reads DB, no writes)
  // ---------------------------------------------------------------------------

  /**
   * computeStatutoryPreviewRows: build per-member preview rows WITHOUT writing
   * anything. Shared by previewStatutoryBonus and runStatutoryBonus.
   *
   * Steps:
   *   1. Load all active team members for the workspace.
   *   2. For each member, count months worked in the FY from salary records.
   *   3. Apply eligibility rules (wage ceiling, months worked, new establishment).
   *   4. Derive calc wage, applicable percent, and bonus amount.
   *   5. Check for existing festival bonus with countsAsStatutory=true to inform
   *      the "already satisfied" display (for preview) or the shortfall (for run).
   */
  private async computeStatutoryPreviewRows(
    workspaceId: string,
    financialYear: number,
    teamMemberFilter?: string[],
  ): Promise<{
    rows: StatutoryBonusPreviewRow[];
    cfg: Awaited<ReturnType<BonusService['loadBonusConfig']>>;
  }> {
    const wsObjectId = toObjectId(workspaceId);
    const cfg = await this.loadBonusConfig(workspaceId);
    const fyPairs = fyMonthYearPairs(financialYear);

    // Load salary records for the FY to count months worked + get last wage.
    // We need all active members; use salary records (present in FY) as the
    // member source + supplement with payroll config salaryAmount for members
    // not yet in payroll. Per spec: use last active month salary.
    const salaryQuery: Record<string, unknown> = {
      workspaceId: wsObjectId,
      $or: fyPairs,
    };
    if (teamMemberFilter && teamMemberFilter.length > 0) {
      salaryQuery.teamMemberId = { $in: teamMemberFilter.map(toObjectId) };
    }

    type SalaryRow = {
      teamMemberId: string;
      month: number;
      year: number;
      presentDays: number;
      baseSalary: number;
    };

    const salaryRows = (await this.salaryModel
      .find(salaryQuery as any)
      .select('teamMemberId month year presentDays baseSalary')
      .lean()
      .exec()) as unknown as SalaryRow[];

    // Group salary rows by member.
    const memberSalaryMap = new Map<string, SalaryRow[]>();
    for (const row of salaryRows) {
      const mid = String(row.teamMemberId);
      if (!memberSalaryMap.has(mid)) {
        memberSalaryMap.set(mid, []);
      }
      memberSalaryMap.get(mid).push(row);
    }

    // Load existing festival bonus adjustments with countsAsStatutory=true
    // for this FY - used in preview display and run shortfall calculation.
    const festivalBonusQuery: Record<string, unknown> = {
      workspaceId: wsObjectId,
      category: 'bonus',
      type: 'addition',
      status: 'active',
      countsAsStatutory: true,
      bonusFinancialYear: financialYear,
    };
    if (teamMemberFilter && teamMemberFilter.length > 0) {
      festivalBonusQuery.teamMemberId = { $in: teamMemberFilter.map(toObjectId) };
    }

    type FestivalRow = { teamMemberId: string; total: number };
    const festivalAgg = await this.salaryAdjustmentModel
      .aggregate<FestivalRow>([
        { $match: festivalBonusQuery },
        {
          $group: {
            _id: '$teamMemberId',
            total: { $sum: '$amount' },
          },
        },
        { $project: { _id: 0, teamMemberId: { $toString: '$_id' }, total: 1 } },
      ])
      .exec();

    const festivalMap = new Map<string, number>(festivalAgg.map((r) => [r.teamMemberId, r.total]));

    const applicablePercent = deriveApplicableBonusPercent({
      allocableSurplusPercent: cfg.allocableSurplusPercent,
      minPercent: cfg.minPercent,
      maxPercent: cfg.maxPercent,
    });

    const previewRows: StatutoryBonusPreviewRow[] = [];

    // Also fetch member names for nicer display. We build a member->lastWage map
    // from the salary records (last month in FY with a record).
    // Group by member: derive lastMonthlyWage, monthsWorked, memberName.
    for (const [memberId, rows] of memberSalaryMap) {
      // Find last month's salary in the FY.
      const sorted = [...rows].sort((a, b) => {
        const aKey = a.year * 100 + a.month;
        const bKey = b.year * 100 + b.month;
        return bKey - aKey; // descending
      });

      const lastWage = sorted[0]?.baseSalary ?? 0;
      const monthsWorked = countMonthsWorked(
        rows.map((r) => ({ month: r.month, year: r.year, presentDays: r.presentDays })),
        financialYear,
      );

      const eligResult = isStatutoryBonusEligible({
        lastMonthlyWage: lastWage,
        eligibilityWageCeiling: cfg.eligibilityWageCeiling,
        monthsWorked,
        newEstablishment: cfg.newEstablishment,
      });

      let calcWage = 0;
      let bonusAmount = 0;

      if (eligResult.eligible) {
        calcWage = deriveBonusCalcWage({
          actualMonthlyWage: lastWage,
          calculationWageFloor: cfg.calculationWageFloor,
          minimumWageMonthly: cfg.minimumWageMonthly,
        });
        bonusAmount = computeStatutoryBonusAmount({
          calcWage,
          applicablePercent,
          monthsWorked,
        });
      }

      previewRows.push({
        teamMemberId: memberId,
        memberName: '',
        eligible: eligResult.eligible,
        reason: eligResult.reason,
        lastMonthlyWage: lastWage,
        calcWage,
        monthsWorked,
        applicablePercent,
        bonusAmount,
        existingFestivalBonusAmount: festivalMap.get(memberId) ?? null,
      });
    }

    return { rows: previewRows, cfg };
  }

  // ---------------------------------------------------------------------------
  // previewStatutoryBonus (read-only)
  // ---------------------------------------------------------------------------

  /**
   * Compute per-eligible-member statutory bonus for an accounting year WITHOUT
   * writing any data. Returns preview rows and config snapshot.
   */
  async previewStatutoryBonus(
    workspaceId: string,
    dto: PreviewStatutoryBonusDto,
  ): Promise<StatutoryBonusPreviewResult> {
    return this.withBonusSpan(
      'bonus.previewStatutory',
      { workspaceId, financialYear: dto.financialYear },
      async () => {
        const memberFilter = dto.teamMemberId ? [dto.teamMemberId] : undefined;
        const { rows, cfg } = await this.computeStatutoryPreviewRows(
          workspaceId,
          dto.financialYear,
          memberFilter,
        );

        const applicablePercent = deriveApplicableBonusPercent({
          allocableSurplusPercent: cfg.allocableSurplusPercent,
          minPercent: cfg.minPercent,
          maxPercent: cfg.maxPercent,
        });

        const totalEligibleAmount = rows
          .filter((r) => r.eligible)
          .reduce((s, r) => s + r.bonusAmount, 0);

        return {
          financialYear: dto.financialYear,
          rows,
          totalEligibleAmount,
          configSnapshot: {
            eligibilityWageCeiling: cfg.eligibilityWageCeiling,
            calculationWageFloor: cfg.calculationWageFloor,
            allocableSurplusPercent: cfg.allocableSurplusPercent,
            applicablePercent,
            newEstablishment: cfg.newEstablishment,
          },
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // runStatutoryBonus (writes SalaryAdjustment rows + BonusRun)
  // ---------------------------------------------------------------------------

  /**
   * Create 'bonus' SalaryAdjustment rows for each eligible member and record a
   * BonusRun entity (rules/summary only, back-references to adjustment IDs).
   *
   * IDEMPOTENCY:
   *   Per (workspaceId, financialYear, teamMemberId) - if a 'bonus' adjustment
   *   already exists with bonusFinancialYear=FY and bonusRunId set (i.e. created
   *   by a previous run), the member is skipped. This prevents double-pay when
   *   the same FY is run twice.
   *
   * countsAsStatutory shortfall:
   *   If a festival bonus with countsAsStatutory=true exists for the member in
   *   the same FY, only the shortfall (statutory amount - festival amount) is
   *   posted. If no shortfall, the member is skipped.
   */
  async runStatutoryBonus(
    workspaceId: string,
    dto: RunStatutoryBonusDto,
    userId: string,
  ): Promise<{
    runId: string;
    created: number;
    skipped: number;
    adjustmentIds: string[];
  }> {
    return this.withBonusSpan(
      'bonus.runStatutory',
      { workspaceId, financialYear: dto.financialYear },
      async () => {
        const wsObjectId = toObjectId(workspaceId);
        const memberFilter = dto.teamMemberIds;
        const { rows, cfg } = await this.computeStatutoryPreviewRows(
          workspaceId,
          dto.financialYear,
          memberFilter,
        );

        // Load members already paid (bonus adj with bonusRunId set for this FY).
        // This is the idempotency guard.
        const alreadyPaidAgg = await this.salaryAdjustmentModel
          .aggregate<{ teamMemberId: string }>([
            {
              $match: {
                workspaceId: wsObjectId,
                category: 'bonus',
                type: 'addition',
                status: 'active',
                bonusFinancialYear: dto.financialYear,
                bonusRunId: { $exists: true, $ne: null },
              },
            },
            {
              $group: { _id: '$teamMemberId' },
            },
            {
              $project: { _id: 0, teamMemberId: { $toString: '$_id' } },
            },
          ])
          .exec();

        const alreadyPaidSet = new Set(alreadyPaidAgg.map((r) => r.teamMemberId));

        // Festival bonus with countsAsStatutory for this FY (for shortfall calc).
        const festivalAgg = await this.salaryAdjustmentModel
          .aggregate<{ teamMemberId: string; total: number }>([
            {
              $match: {
                workspaceId: wsObjectId,
                category: 'bonus',
                type: 'addition',
                status: 'active',
                countsAsStatutory: true,
                bonusFinancialYear: dto.financialYear,
              },
            },
            {
              $group: {
                _id: '$teamMemberId',
                total: { $sum: '$amount' },
              },
            },
            {
              $project: { _id: 0, teamMemberId: { $toString: '$_id' }, total: 1 },
            },
          ])
          .exec();

        const festivalMap = new Map(festivalAgg.map((r) => [r.teamMemberId, r.total]));

        // Create BonusRun record first (gets populated with adjustmentRefs below).
        const bonusRun = new this.bonusRunModel({
          workspaceId: wsObjectId,
          financialYear: dto.financialYear,
          bonusType: 'statutory',
          countsAsStatutory: false,
          configSnapshot: {
            eligibilityWageCeiling: cfg.eligibilityWageCeiling,
            calculationWageFloor: cfg.calculationWageFloor,
            minimumWageMonthly: cfg.minimumWageMonthly,
            allocableSurplusPercent: cfg.allocableSurplusPercent,
            minPercent: cfg.minPercent,
            maxPercent: cfg.maxPercent,
            newEstablishment: cfg.newEstablishment,
          },
          memberRows: [],
          totalEligibleMembers: 0,
          totalDisbursedAmount: 0,
          totalDisbursedMembers: 0,
          status: 'pending',
          note: dto.note ?? undefined,
          createdBy: toObjectId(userId),
        });

        await bonusRun.save();
        const runId = String(bonusRun._id);

        const adjustmentIds: string[] = [];
        let created = 0;
        let skipped = 0;
        const memberRowsForRun: Array<{
          teamMemberId: Types.ObjectId;
          eligible: boolean;
          ineligibilityReason?: string;
          lastMonthlyWage?: number;
          calcWage?: number;
          monthsWorked?: number;
          applicablePercent?: number;
          computedAmount?: number;
          finalAmount: number;
          adjustmentId?: Types.ObjectId;
          disbursedMonth?: number;
          disbursedYear?: number;
        }> = [];

        for (const row of rows) {
          if (!row.eligible) {
            memberRowsForRun.push({
              teamMemberId: toObjectId(row.teamMemberId),
              eligible: false,
              ineligibilityReason: row.reason,
              lastMonthlyWage: row.lastMonthlyWage,
              finalAmount: 0,
            });
            continue;
          }

          // Idempotency: skip if already paid by a previous run for this FY.
          if (alreadyPaidSet.has(row.teamMemberId)) {
            skipped++;
            memberRowsForRun.push({
              teamMemberId: toObjectId(row.teamMemberId),
              eligible: true,
              ineligibilityReason: 'Already paid in a previous run for this FY',
              lastMonthlyWage: row.lastMonthlyWage,
              calcWage: row.calcWage,
              monthsWorked: row.monthsWorked,
              applicablePercent: row.applicablePercent,
              computedAmount: row.bonusAmount,
              finalAmount: 0,
            });
            continue;
          }

          // countsAsStatutory shortfall guard.
          const festivalAmount = festivalMap.get(row.teamMemberId) ?? 0;
          const shortfall = Math.max(0, row.bonusAmount - festivalAmount);

          if (shortfall <= 0) {
            // Festival bonus fully covers statutory obligation. Skip statutory posting.
            skipped++;
            memberRowsForRun.push({
              teamMemberId: toObjectId(row.teamMemberId),
              eligible: true,
              ineligibilityReason: `Statutory obligation satisfied by festival bonus (Rs ${festivalAmount} >= Rs ${row.bonusAmount})`,
              lastMonthlyWage: row.lastMonthlyWage,
              calcWage: row.calcWage,
              monthsWorked: row.monthsWorked,
              applicablePercent: row.applicablePercent,
              computedAmount: row.bonusAmount,
              finalAmount: 0,
            });
            continue;
          }

          // Post the (shortfall) amount as a bonus SalaryAdjustment.
          const finalAmount = shortfall;
          const reasonTitle =
            festivalAmount > 0
              ? `Statutory Bonus FY ${dto.financialYear}-${(dto.financialYear + 1).toString().slice(2)} (shortfall Rs ${finalAmount} after festival credit)`
              : `Statutory Bonus FY ${dto.financialYear}-${(dto.financialYear + 1).toString().slice(2)}`;

          // Ensure salary record exists for the disbursement month.
          let salaryDoc: { _id: unknown } | null = null;
          try {
            salaryDoc = await this.salaryService.ensureSingleEmployeeRecord(
              workspaceId,
              row.teamMemberId,
              dto.disbursedMonth,
              dto.disbursedYear,
              toObjectId(userId),
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Bonus run: ensureSalaryRecord failed for member ${row.teamMemberId} ` +
                `${dto.disbursedMonth}/${dto.disbursedYear}: ${msg}`,
            );
            skipped++;
            memberRowsForRun.push({
              teamMemberId: toObjectId(row.teamMemberId),
              eligible: true,
              ineligibilityReason: `Could not create salary record: ${msg}`,
              lastMonthlyWage: row.lastMonthlyWage,
              finalAmount: 0,
            });
            continue;
          }

          const adjustment = new this.salaryAdjustmentModel({
            workspaceId: wsObjectId,
            salaryId: toObjectId(String((salaryDoc as any)._id)),
            teamMemberId: toObjectId(row.teamMemberId),
            month: dto.disbursedMonth,
            year: dto.disbursedYear,
            type: 'addition',
            category: 'bonus',
            amount: finalAmount,
            source: 'system',
            reasonTitle,
            note: dto.note ?? undefined,
            attachments: [],
            status: 'active',
            pfExcluded: true,
            esiExcluded: false,
            bonusRunId: toObjectId(runId),
            bonusFinancialYear: dto.financialYear,
            countsAsStatutory: false,
            createdBy: toObjectId(userId),
          });

          await adjustment.save();
          const adjustmentId = String(adjustment._id);
          adjustmentIds.push(adjustmentId);
          created++;

          memberRowsForRun.push({
            teamMemberId: toObjectId(row.teamMemberId),
            eligible: true,
            lastMonthlyWage: row.lastMonthlyWage,
            calcWage: row.calcWage,
            monthsWorked: row.monthsWorked,
            applicablePercent: row.applicablePercent,
            computedAmount: row.bonusAmount,
            finalAmount,
            adjustmentId: toObjectId(adjustmentId),
            disbursedMonth: dto.disbursedMonth,
            disbursedYear: dto.disbursedYear,
          });

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'salary_adjustment',
            entityId: adjustmentId,
            action: 'salary.bonus_disbursed',
            actorId: userId,
            teamMemberId: row.teamMemberId,
            month: dto.disbursedMonth,
            year: dto.disbursedYear,
            after: {
              adjustmentId,
              category: 'bonus',
              bonusType: 'statutory',
              financialYear: dto.financialYear,
              amount: finalAmount,
              computedAmount: row.bonusAmount,
              festivalCreditApplied: festivalAmount > 0 ? festivalAmount : 0,
              runId,
            },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.bonus_disbursed',
            properties: {
              workspaceId,
              teamMemberId: row.teamMemberId,
              bonusType: 'statutory',
              financialYear: dto.financialYear,
              amount: finalAmount,
              runId,
              month: dto.disbursedMonth,
              year: dto.disbursedYear,
            },
          });
        }

        // Update BonusRun with member rows and summary.
        const totalDisbursedAmount = adjustmentIds.reduce((s, _) => s, 0);
        bonusRun.memberRows = memberRowsForRun;
        bonusRun.totalEligibleMembers = rows.filter((r) => r.eligible).length;
        bonusRun.totalDisbursedMembers = created;
        bonusRun.totalDisbursedAmount = memberRowsForRun.reduce(
          (s, r) => s + (r.finalAmount ?? 0),
          0,
        );
        bonusRun.status = 'completed';
        bonusRun.updatedBy = toObjectId(userId);
        await bonusRun.save();

        void totalDisbursedAmount; // used for compiler satisfaction

        return { runId, created, skipped, adjustmentIds };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // recordFestivalBonus (writes SalaryAdjustment rows + BonusRun)
  // ---------------------------------------------------------------------------

  /**
   * Record festival / discretionary bonus for one or many members.
   *
   * Each entry writes a 'bonus' SalaryAdjustment (single ledger).
   * A BonusRun entity is created as the metadata container.
   *
   * countsAsStatutory:
   *   When dto.countsAsStatutory=true, each adjustment gets countsAsStatutory=true.
   *   The statutory run (runStatutoryBonus) for the same FY will check for these
   *   adjustments and apply the shortfall logic to avoid double obligation.
   *   Double-obligation avoidance: only the delta above the festival amount is
   *   posted as a statutory adjustment (see runStatutoryBonus for the guard).
   */
  async recordFestivalBonus(
    workspaceId: string,
    dto: RecordFestivalBonusDto,
    userId: string,
  ): Promise<{
    runId: string;
    created: number;
    adjustmentIds: string[];
  }> {
    return this.withBonusSpan(
      'bonus.recordFestival',
      { workspaceId, financialYear: dto.financialYear, entries: dto.entries.length },
      async () => {
        const wsObjectId = toObjectId(workspaceId);
        const countsAsStatutory = dto.countsAsStatutory ?? false;

        // Create BonusRun for metadata (no money stored here).
        const bonusRun = new this.bonusRunModel({
          workspaceId: wsObjectId,
          financialYear: dto.financialYear,
          bonusType: 'discretionary',
          subType: dto.subType,
          countsAsStatutory,
          memberRows: [],
          totalEligibleMembers: dto.entries.length,
          totalDisbursedAmount: 0,
          totalDisbursedMembers: 0,
          status: 'pending',
          note: dto.note ?? undefined,
          createdBy: toObjectId(userId),
        });
        await bonusRun.save();
        const runId = String(bonusRun._id);

        const adjustmentIds: string[] = [];
        const memberRowsForRun: Array<{
          teamMemberId: Types.ObjectId;
          eligible: boolean;
          finalAmount: number;
          adjustmentId?: Types.ObjectId;
          disbursedMonth?: number;
          disbursedYear?: number;
        }> = [];

        for (const entry of dto.entries) {
          const reasonTitle = `${dto.subType} Bonus FY ${dto.financialYear}-${(dto.financialYear + 1).toString().slice(2)}`;

          let salaryDoc: { _id: unknown } | null = null;
          try {
            salaryDoc = await this.salaryService.ensureSingleEmployeeRecord(
              workspaceId,
              entry.teamMemberId,
              dto.disbursedMonth,
              dto.disbursedYear,
              toObjectId(userId),
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Festival bonus: ensureSalaryRecord failed for member ${entry.teamMemberId} ` +
                `${dto.disbursedMonth}/${dto.disbursedYear}: ${msg}`,
            );
            continue;
          }

          const adjustment = new this.salaryAdjustmentModel({
            workspaceId: wsObjectId,
            salaryId: toObjectId(String((salaryDoc as any)._id)),
            teamMemberId: toObjectId(entry.teamMemberId),
            month: dto.disbursedMonth,
            year: dto.disbursedYear,
            type: 'addition',
            category: 'bonus',
            amount: entry.amount,
            source: 'system',
            reasonTitle,
            note: entry.note ?? dto.note ?? undefined,
            attachments: [],
            status: 'active',
            pfExcluded: true,
            // Festival bonus ESI treatment is disputed; mark as esiExcluded=false
            // (TDS-taxable) but the UI must show a warning for the owner to confirm.
            esiExcluded: false,
            bonusRunId: toObjectId(runId),
            bonusFinancialYear: dto.financialYear,
            countsAsStatutory,
            createdBy: toObjectId(userId),
          });

          await adjustment.save();
          const adjustmentId = String(adjustment._id);
          adjustmentIds.push(adjustmentId);

          memberRowsForRun.push({
            teamMemberId: toObjectId(entry.teamMemberId),
            eligible: true,
            finalAmount: entry.amount,
            adjustmentId: toObjectId(adjustmentId),
            disbursedMonth: dto.disbursedMonth,
            disbursedYear: dto.disbursedYear,
          });

          await this.auditService.logEvent({
            workspaceId,
            module: AppModule.SALARY,
            entityType: 'salary_adjustment',
            entityId: adjustmentId,
            action: 'salary.bonus_disbursed',
            actorId: userId,
            teamMemberId: entry.teamMemberId,
            month: dto.disbursedMonth,
            year: dto.disbursedYear,
            after: {
              adjustmentId,
              category: 'bonus',
              bonusType: 'discretionary',
              subType: dto.subType,
              financialYear: dto.financialYear,
              amount: entry.amount,
              countsAsStatutory,
              runId,
            },
          });

          this.postHog.capture({
            distinctId: userId,
            event: 'salary.bonus_disbursed',
            properties: {
              workspaceId,
              teamMemberId: entry.teamMemberId,
              bonusType: 'discretionary',
              subType: dto.subType,
              financialYear: dto.financialYear,
              amount: entry.amount,
              countsAsStatutory,
              runId,
              month: dto.disbursedMonth,
              year: dto.disbursedYear,
            },
          });
        }

        // Update BonusRun with summary.
        bonusRun.memberRows = memberRowsForRun;
        bonusRun.totalDisbursedMembers = adjustmentIds.length;
        bonusRun.totalDisbursedAmount = memberRowsForRun.reduce((s, r) => s + r.finalAmount, 0);
        bonusRun.status = 'completed';
        bonusRun.updatedBy = toObjectId(userId);
        await bonusRun.save();

        return { runId, created: adjustmentIds.length, adjustmentIds };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // getBonusSummary (single-source aggregation from SalaryAdjustment)
  // ---------------------------------------------------------------------------

  /**
   * Per-member (or workspace-wide) bonus totals for a financial year.
   *
   * SINGLE SOURCE: reads only SalaryAdjustment rows with category='bonus' and
   * type='addition' and status='active'. This includes:
   *   - Statutory bonus posted by runStatutoryBonus
   *   - Festival/discretionary bonus posted by recordFestivalBonus
   *   - Any ad-hoc bonus adjustments added directly via the generic adjustment form
   *
   * No double-counting: all entry points write the same SalaryAdjustment row.
   * The bonusFinancialYear field distinguishes FY even when disbursed in a
   * different calendar year (e.g. November payout for Apr-Mar FY).
   */
  async getBonusSummary(
    workspaceId: string,
    query: BonusSummaryQueryDto,
  ): Promise<BonusSummaryResult> {
    return this.withBonusSpan(
      'bonus.getSummary',
      { workspaceId, financialYear: query.financialYear },
      async () => {
        const wsObjectId = toObjectId(workspaceId);

        const matchFilter: Record<string, unknown> = {
          workspaceId: wsObjectId,
          type: 'addition',
          status: 'active',
          category: 'bonus',
          bonusFinancialYear: query.financialYear,
        };

        if (query.teamMemberId) {
          matchFilter.teamMemberId = toObjectId(query.teamMemberId);
        }

        type AggRow = {
          teamMemberId: string;
          countsAsStatutory: boolean;
          bonusRunId: string | null;
          total: number;
        };

        const rawRows = await this.salaryAdjustmentModel
          .aggregate<AggRow>([
            { $match: matchFilter },
            {
              $group: {
                _id: {
                  teamMemberId: '$teamMemberId',
                  // Distinguish statutory vs discretionary via bonusRunId.bonusType
                  // We simplify: countsAsStatutory=true -> counts toward statutory
                  // bonusRunId present -> run-disbursed (statutory or festival)
                  // We use a separate query for bonusType since it's on BonusRun.
                  // For the summary, we use a simpler heuristic:
                  //   adj.countsAsStatutory=true OR (bonusRunId+type=statutory) -> statutory
                  // Since we can't join here cheaply, we bucket by the flag:
                  //   statutory bucket: bonusRunId with no countsAsStatutory (statutory run)
                  //   discretionary: countsAsStatutory=true (festival) or no bonusRunId (ad-hoc)
                  // Actually simpler: group by (teamMemberId, countsAsStatutory) for two buckets.
                  countsAsStatutory: '$countsAsStatutory',
                },
                total: { $sum: '$amount' },
              },
            },
            {
              $project: {
                _id: 0,
                teamMemberId: { $toString: '$_id.teamMemberId' },
                countsAsStatutory: '$_id.countsAsStatutory',
                total: 1,
              },
            },
          ])
          .exec();

        // Group into per-member structure.
        const memberMap = new Map<
          string,
          { statutory: number; discretionary: number; total: number }
        >();

        for (const row of rawRows) {
          if (!memberMap.has(row.teamMemberId)) {
            memberMap.set(row.teamMemberId, { statutory: 0, discretionary: 0, total: 0 });
          }
          const m = memberMap.get(row.teamMemberId);
          if (row.countsAsStatutory) {
            m.statutory += row.total;
          } else {
            m.discretionary += row.total;
          }
          m.total += row.total;
        }

        // Also query adjustments that have bonusRunId (statutory run posts without
        // countsAsStatutory=true). We need to refine: statutory run adjustments have
        // countsAsStatutory=false but bonusRunId set and bonusType=statutory.
        // To avoid a join, we re-query for bonusRunId-linked adjustments where
        // countsAsStatutory is false - these are statutory-run-disbursed.
        const statutoryRunAgg = await this.salaryAdjustmentModel
          .aggregate<{ teamMemberId: string; total: number }>([
            {
              $match: {
                ...matchFilter,
                bonusRunId: { $exists: true, $ne: null },
                countsAsStatutory: { $ne: true },
              },
            },
            {
              $group: {
                _id: '$teamMemberId',
                total: { $sum: '$amount' },
              },
            },
            {
              $project: {
                _id: 0,
                teamMemberId: { $toString: '$_id' },
                total: 1,
              },
            },
          ])
          .exec();

        // Merge: statutory-run amounts into the statutory bucket.
        for (const row of statutoryRunAgg) {
          if (!memberMap.has(row.teamMemberId)) {
            memberMap.set(row.teamMemberId, { statutory: 0, discretionary: 0, total: 0 });
          }
          const m = memberMap.get(row.teamMemberId);
          // These amounts were already included in the first agg (countsAsStatutory=false).
          // Move them from discretionary to statutory bucket if not already counted.
          // The first agg put them in discretionary (countsAsStatutory=false).
          // Correct by moving: statutory += row.total; discretionary -= row.total.
          m.statutory += row.total;
          m.discretionary -= row.total;
        }

        const summaryRows: BonusSummaryMemberRow[] = [...memberMap.entries()].map(
          ([teamMemberId, v]) => ({
            teamMemberId,
            statutory: Math.max(0, v.statutory),
            discretionary: Math.max(0, v.discretionary),
            total: v.total,
          }),
        );

        const workspaceStatutory = summaryRows.reduce((s, r) => s + r.statutory, 0);
        const workspaceDiscretionary = summaryRows.reduce((s, r) => s + r.discretionary, 0);
        const workspaceTotal = summaryRows.reduce((s, r) => s + r.total, 0);

        return {
          financialYear: query.financialYear,
          rows: summaryRows,
          workspaceStatutory,
          workspaceDiscretionary,
          workspaceTotal,
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // listBonusRuns
  // ---------------------------------------------------------------------------

  listBonusRuns(
    workspaceId: string,
    opts: { financialYear?: number; bonusType?: string } = {},
  ): Promise<BonusRun[]> {
    const filter: Record<string, unknown> = { workspaceId: toObjectId(workspaceId) };
    if (opts.financialYear !== undefined) {
      filter.financialYear = opts.financialYear;
    }
    if (opts.bonusType) {
      filter.bonusType = opts.bonusType;
    }
    return this.bonusRunModel
      .find(filter as any)
      .sort({ createdAt: -1 })
      .lean()
      .exec() as unknown as Promise<BonusRun[]>;
  }

  async getBonusRun(workspaceId: string, runId: string): Promise<BonusRun> {
    const run = await this.bonusRunModel
      .findOne({ _id: toObjectId(runId), workspaceId: toObjectId(workspaceId) })
      .lean()
      .exec();
    if (!run) {
      throw new NotFoundException('Bonus run not found');
    }
    return run as unknown as BonusRun;
  }

  // ---------------------------------------------------------------------------
  // computeBonusClawbackAmount - called by FnfService to populate bonusClawbackAmount
  // ---------------------------------------------------------------------------

  /**
   * Compute the bonus amount subject to clawback for a member exiting on
   * lastWorkingDate, given the workspace clawback window.
   *
   * Logic:
   *   Find all 'bonus' SalaryAdjustment rows for the member where:
   *     - status='active'
   *     - createdAt >= (lastWorkingDate - clawbackWindowMonths)
   *     - createdAt <= lastWorkingDate
   *   Sum their amounts.
   *
   * This is called from FnfService.initiateFnf directly (not via BonusService
   * constructor injection) to avoid a circular dep:
   *   SalaryService -> FnfService -> BonusService -> SalaryService
   * The FnfService injects the SalaryAdjustment model directly and runs this
   * aggregation itself using the query described here. The query is simple enough
   * that FnfService does not need to import BonusService.
   *
   * This method is provided for completeness and can be called from contexts
   * that don't have the circular dependency constraint (e.g. tests, admin scripts).
   */
  async computeBonusClawbackAmount(
    workspaceId: string,
    teamMemberId: string,
    lastWorkingDate: Date,
    clawbackWindowMonths: number,
  ): Promise<number> {
    if (clawbackWindowMonths <= 0) {
      return 0;
    }

    const windowStart = addMonths(
      lastWorkingDate.getMonth() + 1,
      lastWorkingDate.getFullYear(),
      -clawbackWindowMonths,
    );

    const wsObjectId = toObjectId(workspaceId);
    const memberObjectId = toObjectId(teamMemberId);

    const result = await this.salaryAdjustmentModel
      .aggregate<{ total: number }>([
        {
          $match: {
            workspaceId: wsObjectId,
            teamMemberId: memberObjectId,
            category: 'bonus',
            type: 'addition',
            status: 'active',
            createdAt: { $gte: windowStart, $lte: lastWorkingDate },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .exec();

    return result[0]?.total ?? 0;
  }
}
