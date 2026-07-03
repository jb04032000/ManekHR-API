import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Salary } from './schemas/salary.schema';
import { Payment } from './schemas/payment.schema';
import { SalaryAdjustment } from './schemas/salary-adjustment.schema';
import { SalaryIncrement } from './schemas/salary-increment.schema';
import { TaxDeclaration } from './schemas/tax-declaration.schema';
import { GratuityLedger } from './schemas/gratuity-ledger.schema';
import { FnfSettlement } from './schemas/fnf-settlement.schema';
import { AdvanceRecoveryPlan } from './schemas/advance-recovery-plan.schema';
import { AdvanceSalaryRequest } from './schemas/advance-salary-request.schema';
import { EmployerLoan } from './schemas/employer-loan.schema';
import { CommissionSchedule } from './schemas/commission-schedule.schema';
import { CashLedgerEntry } from './schemas/cash-ledger-entry.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * SalaryLifecycleService — Salary hardening Pillar 1 (Workstream G, 2026-06-14).
 *
 * Owns the salary module's participation in member removal. Two public methods:
 *
 *  - memberHasHistory(): the salary-side gate behind the Remove-vs-Delete policy
 *    (DATA-MAP §1b). Returns true if the member has ANY salary/payroll/statutory
 *    row, in which case a hard delete must be converted to "remove/offboard".
 *
 *  - onMemberRemoved(): the salary-side cascade the Team module fires when a
 *    member is soft-deleted. It does NOT delete any Bucket-A/B row (those are
 *    retained for 8/10 years, see DATA-MAP-AND-RETENTION). It only halts ACTIVE
 *    recurring state and alerts the owner about open obligations:
 *      1. pause active CommissionSchedules (stop recurring payouts);
 *      2. cancel pending AdvanceSalaryRequests (nothing left to approve);
 *      3. alert the owner about any open EmployerLoan (never auto-write-off —
 *         the employer decides write-off vs F&F recovery).
 *
 * Dependency note:
 *   - reads/writes its own salary collections only (no Team write).
 *   - Team module CALLS onMemberRemoved from TeamService.remove() (the cascade
 *     entry point). memberHasHistory is consumed by the Team permanent-delete
 *     gate. Both are wired via SalaryModule's export of SalaryService.
 *   - alerts via NotificationsService; audits via AuditService.
 */
@Injectable()
export class SalaryLifecycleService {
  private readonly logger = new Logger(SalaryLifecycleService.name);

  constructor(
    @InjectModel(Salary.name) private readonly salaryModel: Model<Salary>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(SalaryAdjustment.name)
    private readonly salaryAdjustmentModel: Model<SalaryAdjustment>,
    @InjectModel(SalaryIncrement.name)
    private readonly incrementModel: Model<SalaryIncrement>,
    @InjectModel(TaxDeclaration.name)
    private readonly taxDeclarationModel: Model<TaxDeclaration>,
    @InjectModel(GratuityLedger.name)
    private readonly gratuityLedgerModel: Model<GratuityLedger>,
    @InjectModel(FnfSettlement.name)
    private readonly fnfSettlementModel: Model<FnfSettlement>,
    @InjectModel(AdvanceRecoveryPlan.name)
    private readonly advanceRecoveryPlanModel: Model<AdvanceRecoveryPlan>,
    @InjectModel(AdvanceSalaryRequest.name)
    private readonly advanceSalaryRequestModel: Model<AdvanceSalaryRequest>,
    @InjectModel(EmployerLoan.name)
    private readonly employerLoanModel: Model<EmployerLoan>,
    @InjectModel(CommissionSchedule.name)
    private readonly commissionScheduleModel: Model<CommissionSchedule>,
    @InjectModel(CashLedgerEntry.name)
    private readonly cashLedgerEntryModel: Model<CashLedgerEntry>,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * DATA-MAP §3 (salary-specific). A member HAS salary history if any one of the
   * retained salary collections holds a doc for (workspaceId, teamMemberId). If
   * true, the delete action MUST be converted to "remove/offboard" — never a hard
   * delete. Cheap: each probe is an indexed `exists` and we short-circuit on the
   * first hit.
   */
  async memberHasHistory(workspaceId: string, teamMemberId: string): Promise<boolean> {
    const ws = new Types.ObjectId(String(workspaceId));
    const tm = new Types.ObjectId(String(teamMemberId));
    const filter = { workspaceId: ws, teamMemberId: tm };

    // Ordered cheapest/most-likely-first; `.exists()` short-circuits.
    const probes: Array<() => Promise<unknown>> = [
      () => this.salaryModel.exists(filter),
      () => this.paymentModel.exists(filter),
      () => this.salaryAdjustmentModel.exists(filter),
      () => this.incrementModel.exists(filter),
      () => this.taxDeclarationModel.exists(filter),
      () => this.gratuityLedgerModel.exists(filter),
      () => this.fnfSettlementModel.exists(filter),
      () => this.advanceRecoveryPlanModel.exists(filter),
      () => this.advanceSalaryRequestModel.exists(filter),
      () => this.employerLoanModel.exists(filter),
      () => this.commissionScheduleModel.exists(filter),
      () => this.cashLedgerEntryModel.exists(filter),
    ];

    for (const probe of probes) {
      const hit = await probe();
      if (hit) return true;
    }
    return false;
  }

  /**
   * Salary-side cascade for member removal (DATA-MAP §4 step 3). Idempotent and
   * non-fatal: a failure here must never block the Team-side soft-delete, so it
   * is wrapped best-effort by the caller. No Bucket-A/B row is deleted.
   */
  async onMemberRemoved(
    workspaceId: string,
    teamMemberId: string,
    actorId: string,
  ): Promise<{ pausedSchedules: number; cancelledRequests: number; openLoans: number }> {
    const ws = new Types.ObjectId(String(workspaceId));
    const tm = new Types.ObjectId(String(teamMemberId));

    // 1. Pause active recurring commission schedules (halt recurring payouts).
    //    Keep the row (Bucket B, 8y) — pause, do not delete.
    const pausedRes = await this.commissionScheduleModel
      .updateMany(
        { workspaceId: ws, teamMemberId: tm, status: 'active' },
        { $set: { status: 'paused' } },
      )
      .exec();

    // 2. Cancel any pending advance requests — nothing remains to approve once
    //    the member is gone. Approved/paid requests are retained untouched
    //    (Bucket B advance authorization record).
    const cancelledRes = await this.advanceSalaryRequestModel
      .updateMany(
        { workspaceId: ws, teamMemberId: tm, status: 'pending' },
        { $set: { status: 'cancelled' } },
      )
      .exec();

    // 3. Surface open employer loans to the owner. Do NOT auto-write-off — the
    //    employer decides write-off vs F&F recovery (perquisite + tax effects).
    const openLoans = await this.employerLoanModel
      .countDocuments({
        workspaceId: ws,
        teamMemberId: tm,
        status: { $in: ['active', 'paused', 'pending_approval'] },
      })
      .exec();

    if (openLoans > 0) {
      try {
        const ownerId = await this.resolveWorkspaceOwnerId(workspaceId);
        if (ownerId) {
          await this.notificationsService.createNotification(workspaceId, {
            recipientId: ownerId,
            title: 'Removed member has open loan(s)',
            message: `A removed team member still has ${openLoans} open employer loan${
              openLoans === 1 ? '' : 's'
            }. Decide whether to write them off or recover via Full & Final settlement.`,
            type: 'warning',
            metadata: {
              kind: 'salary_member_removed_open_loans',
              teamMemberId: String(teamMemberId),
              openLoans,
            },
          });
        }
      } catch (err) {
        // Non-fatal: an alert failure must not abort removal.
        this.logger.warn(
          `onMemberRemoved open-loan alert failed ws=${workspaceId} member=${teamMemberId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }

    const summary = {
      pausedSchedules: pausedRes.modifiedCount ?? 0,
      cancelledRequests: cancelledRes.modifiedCount ?? 0,
      openLoans,
    };

    try {
      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.SALARY,
        entityType: 'team_member',
        entityId: String(teamMemberId),
        action: 'salary.member_removed_cascade',
        actorId,
        teamMemberId: String(teamMemberId),
        meta: summary,
      });
    } catch (err) {
      this.logger.warn(
        `onMemberRemoved audit failed ws=${workspaceId} member=${teamMemberId}: ${
          (err as Error)?.message ?? err
        }`,
      );
    }

    this.logger.log(
      `salary onMemberRemoved ws=${workspaceId} member=${teamMemberId} ` +
        `pausedSchedules=${summary.pausedSchedules} cancelledRequests=${summary.cancelledRequests} openLoans=${summary.openLoans}`,
    );

    return summary;
  }

  // Resolve the workspace owner via the Workspace collection (reached through
  // the salary model's connection so we avoid a Workspace model injection here).
  private async resolveWorkspaceOwnerId(workspaceId: string): Promise<string | null> {
    const ws = await this.salaryModel.db
      .collection('workspaces')
      .findOne({ _id: new Types.ObjectId(String(workspaceId)) }, { projection: { ownerId: 1 } });
    return ws?.ownerId ? String(ws.ownerId) : null;
  }
}
