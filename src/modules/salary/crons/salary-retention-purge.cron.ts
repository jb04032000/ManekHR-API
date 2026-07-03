import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditService } from '../../audit/audit.service';
import { buildRetentionPurgeAuditEvent } from '../../audit/retention-purge-audit';
import { AppModule } from '../../../common/enums/modules.enum';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { PayrollConfig } from '../schemas/payroll-config.schema';
import { Salary } from '../schemas/salary.schema';
import { Payment } from '../schemas/payment.schema';
import { SalaryAdjustment } from '../schemas/salary-adjustment.schema';
import { SalaryIncrement } from '../schemas/salary-increment.schema';
import { TaxDeclaration } from '../schemas/tax-declaration.schema';
import { GratuityLedger } from '../schemas/gratuity-ledger.schema';
import { FnfSettlement } from '../schemas/fnf-settlement.schema';
import { AdvanceRecoveryPlan } from '../schemas/advance-recovery-plan.schema';
import { AdvanceSalaryRequest } from '../schemas/advance-salary-request.schema';
import { EmployerLoan } from '../schemas/employer-loan.schema';
import { CommissionSchedule } from '../schemas/commission-schedule.schema';
import { CashLedgerEntry } from '../schemas/cash-ledger-entry.schema';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CRON_TIMEZONES } from '../../../common/constants/cron.constants';
import { env } from '../../../config/env';

/**
 * HARD statutory retention floors (security-review fix HIGH-2).
 *
 * These are the LEGAL MINIMUM windows for a destructive, irreversible purge and
 * are CODE CONSTANTS, not env knobs — neither `SALARY_RETENTION_*` env values nor
 * a per-workspace override can ever drop a window below these. The env value and
 * the workspace override can only EXTEND retention (keep records longer), never
 * shorten it. An operator setting SALARY_RETENTION_PAYROLL_YEARS=1 therefore still
 * yields an 8-year cutoff — the floor wins.
 *
 *   - 8 years  — payroll / PF / ESI / PT / TDS / advance / loan / commission
 *                (Payment of Bonus Act + Income-Tax record-retention norms).
 *   - 10 years — Gujarat wage register (monthly Salary record) + daily-wage cash
 *                ledger (Gujarat Shops & Establishments / Minimum Wages registers).
 *
 * See docs/compliance/DATA-MAP-AND-RETENTION.md §2.
 */
export const STATUTORY_PAYROLL_FLOOR_YEARS = 8;
export const STATUTORY_WAGE_FLOOR_YEARS = 10;

/**
 * SalaryRetentionPurgeCron — Salary hardening Pillar 1 (OQ-S4).
 *
 * The SYSTEM-ONLY permanent-purge path (DATA-MAP §1b / §3 step 6). Hard-erases
 * salary/payroll/statutory rows ONLY after the retention window has lapsed —
 * never as a user action. This is the only place in the salary module that
 * physically deletes Bucket-B data.
 *
 * Safety rails:
 *   - OFF by default (env.salaryRetention.enabled = RUN_RETENTION_PURGE_ON_SCHEDULE,
 *     default false). With the flag off the cron logs and exits — prod never
 *     auto-purges until the owner + CA enable it.
 *   - Per-workspace window = max(workspace override, env value, HARD floor
 *     constant). A workspace OR the env can keep records LONGER, never shorter
 *     than the 8y/10y statutory floor (security-review fix HIGH-2).
 *   - Two windows: 8y for payroll/tax/statutory; 10y for the Gujarat wage
 *     register + daily-wage cash ledger (and the monthly Salary register, which
 *     IS the wage register → the longer 10y window applies).
 *   - Single-flight (Redis) so a multi-worker deploy purges once per day.
 *   - Cutoff is computed on `updatedAt` (every salary schema has timestamps:true),
 *     so a recently-touched 9-year-old record (a fresh installment, recovery
 *     posting, or status change) keeps a full window and is NOT erased while still
 *     live/tax-relevant (security-review fix MEDIUM-1). A row updated < window ago
 *     is always retained, fail-safe.
 *   - Non-terminal records (EmployerLoan / CommissionSchedule / AdvanceRecoveryPlan
 *     in a still-live status) are EXCLUDED entirely — only settled/closed rows are
 *     ever eligible (security-review fix MEDIUM-1).
 *
 * Reuses the audit-module retention philosophy (tier-aware days → cutoff date)
 * adapted to per-workspace year windows.
 *
 * Dependency note: reads workspaces + payroll_configs; hard-deletes the salary
 * collections it owns. No cross-module write.
 */
@Injectable()
export class SalaryRetentionPurgeCron {
  private readonly logger = new Logger(SalaryRetentionPurgeCron.name);

  constructor(
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>,
    @InjectModel(PayrollConfig.name) private readonly payrollConfigModel: Model<PayrollConfig>,
    @InjectModel(Salary.name) private readonly salaryModel: Model<Salary>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(SalaryAdjustment.name)
    private readonly salaryAdjustmentModel: Model<SalaryAdjustment>,
    @InjectModel(SalaryIncrement.name) private readonly incrementModel: Model<SalaryIncrement>,
    @InjectModel(TaxDeclaration.name) private readonly taxDeclarationModel: Model<TaxDeclaration>,
    @InjectModel(GratuityLedger.name) private readonly gratuityLedgerModel: Model<GratuityLedger>,
    @InjectModel(FnfSettlement.name) private readonly fnfSettlementModel: Model<FnfSettlement>,
    @InjectModel(AdvanceRecoveryPlan.name)
    private readonly advanceRecoveryPlanModel: Model<AdvanceRecoveryPlan>,
    @InjectModel(AdvanceSalaryRequest.name)
    private readonly advanceSalaryRequestModel: Model<AdvanceSalaryRequest>,
    @InjectModel(EmployerLoan.name) private readonly employerLoanModel: Model<EmployerLoan>,
    @InjectModel(CommissionSchedule.name)
    private readonly commissionScheduleModel: Model<CommissionSchedule>,
    @InjectModel(CashLedgerEntry.name)
    private readonly cashLedgerEntryModel: Model<CashLedgerEntry>,
    private readonly singleFlight: SingleFlightService,
    // Phase 7 audit-at-purge (plan §8): the grievance-trail record of every
    // destructive purge. @Optional so the positional unit tests keep compiling;
    // DI supplies it in the app (SalaryModule imports AuditModule). Best-effort —
    // an audit failure is logged but never aborts the (already-done) purge.
    @Optional() private readonly auditService?: AuditService,
  ) {}

  /**
   * CRON CONTRACT — Salary retention purge (OQ-S4)
   * Execution:   @Cron + Redis single-flight per day. Disabled unless
   *              RUN_RETENTION_PURGE_ON_SCHEDULE=true.
   * Schedule:    daily 03:30 UTC (clear of payroll-auto-generate 00:15 + absence
   *              -loss 01:00 + commission 02:30).
   * Idempotent:  YES — deletes only rows already past the window; a second run
   *              finds nothing new for the same day.
   * Reads:       workspaces, payroll_configs
   * Writes:      HARD-DELETE of expired salary collections (Bucket B).
   * Owner:       salary
   */
  @Cron('30 3 * * *', { timeZone: CRON_TIMEZONES.UTC })
  async handlePurge(): Promise<void> {
    if (!env.salaryRetention.enabled) {
      this.logger.debug(
        'Salary retention purge disabled (RUN_RETENTION_PURGE_ON_SCHEDULE != true); skipping.',
      );
      return;
    }
    await this.singleFlight.runExclusive('salary.retention_purge', dayBucket(), () =>
      this.process(),
    );
  }

  private cutoff(years: number): Date {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d;
  }

  private async process(): Promise<void> {
    this.logger.log('Salary retention purge starting...');

    const floorPayroll = env.salaryRetention.payrollYears;
    const floorWage = env.salaryRetention.wageLedgerYears;

    const workspaces = await this.workspaceModel.find({}).select('_id name').lean().exec();

    let totalDeleted = 0;

    for (const ws of workspaces) {
      const workspaceId = String(ws._id);
      try {
        // Per-workspace window = clamp(override, floor). Legacy docs without a
        // `retention` sub-doc fall back to the env floor.
        const config = await this.payrollConfigModel
          .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
          .select('retention')
          .lean()
          .exec();

        // Window = max(per-workspace override, env value, HARD floor constant).
        // The HARD floor is the legal minimum (HIGH-2): neither an env knob set
        // below the floor nor a too-short workspace override can shorten the
        // window — both can only extend it. `floorPayroll`/`floorWage` are the env
        // values, kept in the max() so an env value ABOVE the constant still wins.
        const payrollYears = Math.max(
          config?.retention?.payrollYears ?? floorPayroll,
          floorPayroll,
          STATUTORY_PAYROLL_FLOOR_YEARS,
        );
        const wageYears = Math.max(
          config?.retention?.wageLedgerYears ?? floorWage,
          floorWage,
          STATUTORY_WAGE_FLOOR_YEARS,
        );

        const payrollCutoff = this.cutoff(payrollYears);
        const wageCutoff = this.cutoff(wageYears);
        const wsOid = new Types.ObjectId(workspaceId);

        // MEDIUM-1: anchor every cutoff on `updatedAt`, not `createdAt`, so a
        // recently-touched old record keeps a fresh window and is not erased while
        // still live/tax-relevant.
        // 10-year window (wage register + daily-wage cash ledger). The monthly
        // Salary record IS the Gujarat wage register, so it gets the longer
        // window even though salary-adjustments (statutory deductions) sit at 8y.
        const wageDeletes = await Promise.all([
          this.salaryModel.deleteMany({ workspaceId: wsOid, updatedAt: { $lt: wageCutoff } }),
          this.cashLedgerEntryModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: wageCutoff },
          }),
        ]);

        // 8-year window (payroll / tax / statutory / advance / loan / commission).
        // MEDIUM-1: EmployerLoan, CommissionSchedule, and AdvanceRecoveryPlan are
        // additionally filtered to TERMINAL statuses only — a still-live loan/
        // schedule/recovery (active/paused/pending_approval/draft) is never purged
        // regardless of age, because it remains an open contractual obligation.
        const payrollDeletes = await Promise.all([
          this.paymentModel.deleteMany({ workspaceId: wsOid, updatedAt: { $lt: payrollCutoff } }),
          this.salaryAdjustmentModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: payrollCutoff },
          }),
          this.incrementModel.deleteMany({ workspaceId: wsOid, updatedAt: { $lt: payrollCutoff } }),
          this.taxDeclarationModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: payrollCutoff },
          }),
          this.gratuityLedgerModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: payrollCutoff },
          }),
          this.fnfSettlementModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: payrollCutoff },
          }),
          this.advanceRecoveryPlanModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: payrollCutoff },
            // Terminal only — never erase an active/paused recovery plan.
            status: { $nin: ['active', 'paused'] },
          }),
          this.advanceSalaryRequestModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: payrollCutoff },
          }),
          this.employerLoanModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: payrollCutoff },
            // Terminal only — never erase a draft/pending/active/paused loan.
            status: { $nin: ['draft', 'pending_approval', 'active', 'paused'] },
          }),
          this.commissionScheduleModel.deleteMany({
            workspaceId: wsOid,
            updatedAt: { $lt: payrollCutoff },
            // Terminal only — never erase an active/paused commission schedule.
            status: { $nin: ['active', 'paused'] },
          }),
        ]);

        const deleted =
          wageDeletes.reduce((sum, r) => sum + (r.deletedCount ?? 0), 0) +
          payrollDeletes.reduce((sum, r) => sum + (r.deletedCount ?? 0), 0);

        if (deleted > 0) {
          totalDeleted += deleted;
          this.logger.log(
            `Salary retention purge ws="${ws.name ?? workspaceId}" deleted=${deleted} ` +
              `(payrollYears=${payrollYears} wageYears=${wageYears})`,
          );
          // Phase 7 grievance trail — record WHAT was purged, the basis, and the
          // elapsed-window cutoffs (the wage register sits at the 10y window, the
          // rest at 8y). Best-effort; never aborts the purge.
          await this.auditPurge(
            workspaceId,
            deleted,
            {
              salary: wageDeletes[0].deletedCount ?? 0,
              cashLedgerEntry: wageDeletes[1].deletedCount ?? 0,
              payment: payrollDeletes[0].deletedCount ?? 0,
              salaryAdjustment: payrollDeletes[1].deletedCount ?? 0,
              salaryIncrement: payrollDeletes[2].deletedCount ?? 0,
              taxDeclaration: payrollDeletes[3].deletedCount ?? 0,
              gratuityLedger: payrollDeletes[4].deletedCount ?? 0,
              fnfSettlement: payrollDeletes[5].deletedCount ?? 0,
              advanceRecoveryPlan: payrollDeletes[6].deletedCount ?? 0,
              advanceSalaryRequest: payrollDeletes[7].deletedCount ?? 0,
              employerLoan: payrollDeletes[8].deletedCount ?? 0,
              commissionSchedule: payrollDeletes[9].deletedCount ?? 0,
            },
            { payroll: payrollYears, wage: wageYears },
            { payroll: payrollCutoff.toISOString(), wage: wageCutoff.toISOString() },
          );
        }
      } catch (err) {
        this.logger.error(
          `Salary retention purge failed for workspace ${workspaceId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }

    this.logger.log(`Salary retention purge complete. Total rows deleted=${totalDeleted}.`);
  }

  /**
   * Best-effort grievance-trail audit of one workspace's purge (plan §8). No-op
   * when AuditService is not wired (positional unit tests). An audit failure is
   * logged but never thrown — the purge has already committed.
   */
  private async auditPurge(
    workspaceId: string,
    totalDeleted: number,
    collections: Record<string, number>,
    windowYears: Record<string, number>,
    cutoffs: Record<string, string>,
  ): Promise<void> {
    if (!this.auditService) return;
    try {
      await this.auditService.logEvent(
        buildRetentionPurgeAuditEvent({
          module: AppModule.SALARY,
          systemUserId: env.systemUserId,
          workspaceId,
          totalDeleted,
          collections,
          windowYears,
          cutoffs,
          basis: 'statutory-retention-floor',
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Salary retention purge audit failed for workspace ${workspaceId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
}
