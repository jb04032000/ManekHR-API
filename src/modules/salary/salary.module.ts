import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { SalaryService } from './salary.service';
import { SalaryController } from './salary.controller';
import { Salary, SalarySchema } from './schemas/salary.schema';
import { Payment, PaymentSchema } from './schemas/payment.schema';
import { SalaryIncrement, SalaryIncrementSchema } from './schemas/salary-increment.schema';
import { SalaryAdjustment, SalaryAdjustmentSchema } from './schemas/salary-adjustment.schema';
import { PayrollConfig, PayrollConfigSchema } from './schemas/payroll-config.schema';
import {
  SalaryComponentTemplate,
  SalaryComponentTemplateSchema,
} from './schemas/salary-component-template.schema';
import { PtSlabConfig, PtSlabConfigSchema } from './schemas/pt-slab.schema';
import { TaxDeclaration, TaxDeclarationSchema } from './schemas/tax-declaration.schema';
import { GratuityLedger, GratuityLedgerSchema } from './schemas/gratuity-ledger.schema';
import { FnfSettlement, FnfSettlementSchema } from './schemas/fnf-settlement.schema';
import { TdsChallan, TdsChallanSchema } from './schemas/tds-challan.schema';
import { ComplianceExportService } from './compliance-export.service';
import { ComplianceGuardService } from './compliance-guard.service';
import { LoanService } from './loan.service';
import { TdsService } from './tds.service';
import { GratuityService } from './gratuity.service';
import { FnfService } from './fnf.service';
import { TdsChallanService } from './tds-challan.service';
import { TeamModule } from '../team/team.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { AttendancePoliciesModule } from '../attendance-policies/attendance-policies.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { MailModule } from '../mail/mail.module';
import { Workspace, WorkspaceSchema } from '../workspaces/schemas/workspace.schema';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PayrollAutoGenerateCron } from './crons/payroll-auto-generate.cron';
import { TdsChallanController } from './tds-challan.controller';
import { BulkEmailJob, BulkEmailJobSchema } from './schemas/bulk-email-job.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { PayslipPdfService } from './payslip-pdf.service';
import { ProductionLogSchema } from '../production-logs/schemas/production-log.schema';
import { MachineSchema } from '../machines/schemas/machine.schema';
import {
  PieceRateConfigAudit,
  PieceRateConfigAuditSchema,
} from './schemas/piece-rate-config-audit.schema';
import { LeaveRequest, LeaveRequestSchema } from '../leave/schemas/leave-request.schema';
import { LeaveType, LeaveTypeSchema } from '../leave/schemas/leave-type.schema';
import { LeaveBalance, LeaveBalanceSchema } from '../leave/schemas/leave-balance.schema';
import {
  EncashmentRecord,
  EncashmentRecordSchema,
} from '../leave/schemas/encashment-record.schema';
import {
  AdvanceRecoveryPlan,
  AdvanceRecoveryPlanSchema,
} from './schemas/advance-recovery-plan.schema';
import {
  AdvanceSalaryRequest,
  AdvanceSalaryRequestSchema,
} from './schemas/advance-salary-request.schema';
import { LoanRequest, LoanRequestSchema } from './schemas/loan-request.schema';
import { AdvanceSalaryRequestService } from './advance-salary-request.service';
import { EmployerLoan, EmployerLoanSchema } from './schemas/employer-loan.schema';
import { CommissionSchedule, CommissionScheduleSchema } from './schemas/commission-schedule.schema';
import { CommissionService } from './commission.service';
import { CommissionScheduleCron } from './crons/commission-schedule.cron';
import { BonusRun, BonusRunSchema } from './schemas/bonus-run.schema';
import { BonusService } from './bonus.service';
import { CashLedgerEntry, CashLedgerEntrySchema } from './schemas/cash-ledger-entry.schema';
import { CashLedgerService } from './cash-ledger.service';
import { SalaryDisbursementGuardService } from './salary-disbursement-guard.service';
import { AdvanceSalaryRequestController } from './advance-salary-request.controller';
import { LoanRequestController } from './loan-request.controller';
import { LoanRequestService } from './loan-request.service';
import { SalaryAbsenceLossService } from './salary-absence-loss.service';
import { SalaryAbsenceLossCron } from './crons/salary-absence-loss.cron';
import { SalaryLedgerPostingService } from './salary-ledger-posting.service';
// Workstream G hardening (2026-06-14): shared write guard (SoD + offboard lock),
// member-removal cascade + history gate, and the system-only retention purge.
import { SalaryWriteGuardService } from './salary-write-guard.service';
import { SalaryLifecycleService } from './salary-lifecycle.service';
import { SalaryRetentionPurgeCron } from './crons/salary-retention-purge.cron';
import {
  RegularizationRequest,
  RegularizationRequestSchema,
} from '../regularization/schemas/regularization-request.schema';
import {
  LedgerEntry,
  LedgerEntrySchema,
} from '../finance/sales/ledger-posting/ledger-entry.schema';
import { FirmsModule } from '../finance/firms/firms.module';
import { LedgerModule } from '../finance/ledger/ledger.module';
// Phase 6 (member-cap read filter): ErpMemberCapService for scoping the org-
// scoped salary reports (getSalaryRecords + paginated/summary aggregates) to the
// allowed member set. ErpMemberCapModule imports none of Team/Salary/Attendance,
// so the dependency direction stays acyclic.
import { ErpMemberCapModule } from '../subscriptions/member-cap/erp-member-cap.module';

@Module({
  imports: [
    // CANONICAL single ScheduleModule.forRoot() for the whole app. The schedule
    // explorer scans EVERY provider's @Cron across all modules, so one
    // registration here activates every cron in the app. Do NOT remove this, and
    // do NOT add forRoot() to other modules: forRoot() is not idempotent in
    // @nestjs/schedule v6 — each extra call fires every cron one more time per
    // tick (the root cause of duplicate single-flight "skipping" logs).
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      { name: Salary.name, schema: SalarySchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: SalaryIncrement.name, schema: SalaryIncrementSchema },
      { name: SalaryAdjustment.name, schema: SalaryAdjustmentSchema },
      { name: PayrollConfig.name, schema: PayrollConfigSchema },
      {
        name: SalaryComponentTemplate.name,
        schema: SalaryComponentTemplateSchema,
      },
      { name: PtSlabConfig.name, schema: PtSlabConfigSchema },
      { name: TaxDeclaration.name, schema: TaxDeclarationSchema },
      { name: GratuityLedger.name, schema: GratuityLedgerSchema },
      { name: FnfSettlement.name, schema: FnfSettlementSchema },
      { name: TdsChallan.name, schema: TdsChallanSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: BulkEmailJob.name, schema: BulkEmailJobSchema },
      { name: User.name, schema: UserSchema },
      { name: 'ProductionLog', schema: ProductionLogSchema },
      { name: 'Machine', schema: MachineSchema },
      { name: PieceRateConfigAudit.name, schema: PieceRateConfigAuditSchema },
      // Leave schemas by name — L4 event-based coupling (L4a paid leave →
      // credited payroll day; L4b FnF encashment reads the balance). No
      // LeaveModule import, so no cycle.
      { name: LeaveRequest.name, schema: LeaveRequestSchema },
      { name: LeaveType.name, schema: LeaveTypeSchema },
      { name: LeaveBalance.name, schema: LeaveBalanceSchema },
      { name: EncashmentRecord.name, schema: EncashmentRecordSchema },
      { name: AdvanceRecoveryPlan.name, schema: AdvanceRecoveryPlanSchema },
      { name: EmployerLoan.name, schema: EmployerLoanSchema },
      { name: CommissionSchedule.name, schema: CommissionScheduleSchema },
      { name: BonusRun.name, schema: BonusRunSchema },
      { name: CashLedgerEntry.name, schema: CashLedgerEntrySchema },
      { name: AdvanceSalaryRequest.name, schema: AdvanceSalaryRequestSchema },
      // Employee-originated self-service loan request layer (Task 1 foundation;
      // consumer service + endpoints land in Task 2).
      { name: LoanRequest.name, schema: LoanRequestSchema },
      // RegularizationRequest — by name token, for SalaryAbsenceLossService (D-03 approved-check).
      // No RegularizationModule import needed; schema registered directly.
      { name: RegularizationRequest.name, schema: RegularizationRequestSchema },
      // LedgerEntry — by name token, for SalaryLedgerPostingService (D-06 double-entry posting).
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
    FirmsModule, // provides FirmsService for firm resolution (D-07)
    LedgerModule, // provides AccountsService for COA account lookup (D-06/D-10)
    forwardRef(() => TeamModule),
    forwardRef(() => AttendanceModule), // H3-05: circular dep — AttendanceModule also imports SalaryModule via forwardRef
    AttendancePoliciesModule,
    ShiftsModule,
    SubscriptionsModule,
    WorkspacesModule,
    ErpMemberCapModule, // Phase 6: ErpMemberCapService for the org-scoped report cap.
    MailModule,
    AuditModule,
    NotificationsModule,
  ],
  controllers: [
    SalaryController,
    TdsChallanController,
    AdvanceSalaryRequestController,
    LoanRequestController,
  ],
  providers: [
    SalaryService,
    PayslipPdfService,
    PayrollAutoGenerateCron,
    TdsService,
    TdsChallanService,
    GratuityService,
    FnfService,
    ComplianceExportService,
    ComplianceGuardService,
    LoanService,
    CommissionService,
    CommissionScheduleCron,
    BonusService,
    CashLedgerService,
    AdvanceSalaryRequestService,
    LoanRequestService,
    SalaryDisbursementGuardService,
    SalaryAbsenceLossService,
    SalaryAbsenceLossCron,
    SalaryLedgerPostingService,
    // Workstream G hardening providers.
    SalaryWriteGuardService,
    SalaryLifecycleService,
    SalaryRetentionPurgeCron,
  ],
  exports: [
    SalaryService,
    TdsService,
    TdsChallanService,
    GratuityService,
    FnfService,
    ComplianceGuardService,
    LoanService,
    AdvanceSalaryRequestService,
    SalaryLedgerPostingService,
    // Exported so the Team module can drive the member-removal cascade +
    // history gate (TeamService.remove / removePermanent).
    SalaryLifecycleService,
    MongooseModule,
  ],
})
export class SalaryModule {}
