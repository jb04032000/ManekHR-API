import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { Salary } from './salary.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { User } from '../../users/schemas/user.schema';

export const SALARY_ADDITION_CATEGORIES = [
  // Note: Historical commission adjustments may use category 'incentive' with source 'payment_recording'.
  // New commission adjustments created after Sprint 9 use category 'commission'.
  'bonus',
  'overtime',
  'reimbursement',
  'allowance',
  'incentive',
  'commission',
  'other',
  // Phantom taxable addition for employer-loan perquisite valuation (IT Rule 3(7)(i)).
  // Raises the TDS/gross-for-tax base without affecting net cash pay.
  'loan_perquisite',
] as const;

export const SALARY_DEDUCTION_CATEGORIES = [
  'penalty',
  'advance_recovery',
  'loan_recovery',
  'fine',
  'absence_recovery',
  'other',
  'pf_employee',
  'esi_employee',
  'pt_employee',
  'tds_employee',
  'lwf_employee',
] as const;

@Schema({ timestamps: true })
export class SalaryAdjustment extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Salary', required: true })
  salaryId: Salary | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: TeamMember | Types.ObjectId;

  @Prop({ required: true })
  month: number;

  @Prop({ required: true })
  year: number;

  @Prop({ enum: ['addition', 'deduction'], required: true })
  type: 'addition' | 'deduction';

  @Prop({ required: true })
  category: string;

  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({
    type: String,
    enum: ['manual', 'payment_recording', 'system'],
    default: 'manual',
  })
  source: string;

  @Prop({ type: Types.ObjectId, ref: 'Payment' })
  linkedPaymentId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Payment' })
  advanceSourcePaymentId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'SalaryAdjustment' })
  correctionOfAdjustmentId?: SalaryAdjustment | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'AdvanceRecoveryPlan' })
  advanceRecoveryPlanId?: Types.ObjectId;

  /** set for loan_recovery deductions and loan_perquisite additions linked to a loan */
  @Prop({ type: Types.ObjectId, ref: 'EmployerLoan' })
  employerLoanId?: Types.ObjectId;

  @Prop({ type: Number })
  planInstallmentIndex?: number;

  @Prop({ required: true, trim: true })
  reasonTitle: string;

  @Prop({ trim: true })
  note?: string;

  @Prop({ type: [String], default: [] })
  attachments: string[];

  @Prop({ enum: ['active', 'reversed'], default: 'active' })
  status: 'active' | 'reversed';

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: User | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  reversedBy?: User | Types.ObjectId;

  @Prop()
  reversedAt?: Date;

  @Prop({ trim: true })
  reversalReason?: string;

  /**
   * Marks whether this adjustment amount is excluded from PF basic wages.
   * Defaults to false. Set to true automatically for commission and incentive
   * categories because neither forms part of "basic wages" under the PF Act.
   * Metadata only: the PF ECR export already uses baseSalary exclusively
   * (compliance-export.service.ts:164-167) so setting this flag does not
   * change the export path - it exists for audit display and payslip annotation.
   */
  @Prop({ type: Boolean, default: false })
  pfExcluded?: boolean;

  /**
   * Marks whether this adjustment amount is excluded from ESI wages.
   * Defaults to false. Set to true automatically for commission and incentive
   * categories under the actual-basis wage definition in the Code on Wages.
   * Same metadata-only caveat as pfExcluded above.
   */
  @Prop({ type: Boolean, default: false })
  esiExcluded?: boolean;

  /**
   * Links this adjustment to the CommissionSchedule rule that produced it
   * when source is 'system' (scheduled dispatch). Null for ad-hoc entries.
   */
  @Prop({ type: Types.ObjectId, ref: 'CommissionSchedule' })
  commissionScheduleId?: Types.ObjectId;

  /**
   * Links this adjustment to the BonusRun that produced it when category='bonus'
   * and source='system' (run by BonusService). Null for ad-hoc bonus entries.
   * Back-reference only; the money is authoritative here, not on BonusRun.
   */
  @Prop({ type: Types.ObjectId, ref: 'BonusRun' })
  bonusRunId?: Types.ObjectId;

  /**
   * When true, this bonus adjustment (category='bonus') also counts toward the
   * statutory obligation for the member + financial year. Used by the statutory
   * run to avoid double-paying when a festival bonus was already given.
   * Only meaningful when category='bonus'. See BonusService for the guard logic.
   */
  @Prop({ type: Boolean, default: false })
  countsAsStatutory?: boolean;

  /**
   * Financial year this bonus applies to (e.g. 2025 for FY 2025-26, Apr-Mar).
   * Set on bonus adjustments for idempotency and clawback queries.
   * Null for non-bonus adjustments.
   */
  @Prop({ type: Number })
  bonusFinancialYear?: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const SalaryAdjustmentSchema = SchemaFactory.createForClass(SalaryAdjustment);

SalaryAdjustmentSchema.index({ workspaceId: 1, salaryId: 1, createdAt: -1 });
SalaryAdjustmentSchema.index({
  workspaceId: 1,
  teamMemberId: 1,
  month: 1,
  year: 1,
});
SalaryAdjustmentSchema.index({ workspaceId: 1, correctionOfAdjustmentId: 1 });
SalaryAdjustmentSchema.index({ workspaceId: 1, advanceRecoveryPlanId: 1, status: 1 });
SalaryAdjustmentSchema.index({ workspaceId: 1, employerLoanId: 1, status: 1 });

// salaryId-leading index (launch perf — Workstream F). The salary list/overview
// aggregations (buildSalaryAggregationBasePipeline) run a correlated $lookup into
// salaryadjustments that matches ONLY on salaryId == $$salaryId, with NO
// workspaceId in the sub-pipeline — so none of the workspaceId-leading indexes
// above can serve it, and it scanned the collection once per team-member row on
// the most-trafficked salary list endpoint (multiplied ~8x by /overview's
// trend-month pipelines). A salaryId-leading index makes that per-row lookup a
// tight IXSCAN. Additive, no migration.
SalaryAdjustmentSchema.index({ salaryId: 1 });
