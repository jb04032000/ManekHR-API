import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class FnfSettlement extends Document {
  @Prop({ type: Types.ObjectId, required: true, ref: 'Workspace' })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, ref: 'TeamMember' })
  teamMemberId: Types.ObjectId;

  @Prop({ required: true })
  dateOfJoining: Date;

  @Prop({ required: true })
  lastWorkingDate: Date;

  @Prop({ default: '' })
  resignationReason: string;

  @Prop({ default: 0 })
  completedYears: number;

  @Prop({ default: 0 })
  completedMonths: number;

  @Prop({ default: 0 })
  lastBasicSalary: number;

  @Prop({ default: 0 })
  lastGrossSalary: number;

  @Prop({ type: Types.ObjectId, ref: 'Salary' })
  lastSalaryRecordId: Types.ObjectId;

  @Prop({ default: 0 })
  lastMonthNetSalary: number;

  @Prop({ default: false })
  gratuityEligible: boolean;

  @Prop({ default: 0 })
  gratuityAmount: number;

  @Prop({ default: 0 })
  leaveBalanceDays: number;

  @Prop({ default: 0 })
  leaveEncashmentAmount: number;

  @Prop({ default: false })
  leaveBalanceManuallyEntered: boolean;

  @Prop({ default: 0 })
  noticePeriodDays: number;

  @Prop({ default: 0 })
  noticeServedDays: number;

  @Prop({ default: 0 })
  noticeShortfallDays: number;

  @Prop({ default: 0 })
  noticeRecoveryAmount: number;

  @Prop({ default: 0 })
  outstandingAdvanceAmount: number;

  // Phase 1 (advance-loan compliance): gratuity-protected deduction split.
  // outstandingAdvanceAmount = raw outstanding at F&F initiation time.
  // advanceRecoverableFromDues = min(outstanding, non-gratuity pool after other deductions).
  // advanceResidualUnrecovered = outstanding - recoverable (>0 triggers owner alert).
  @Prop({ default: 0 })
  advanceRecoverableFromDues: number;

  @Prop({ default: 0 })
  advanceResidualUnrecovered: number;

  // Loan module (Phase 2): sum of remainingAmount across all active EmployerLoans
  // at the time F&F is initiated. Recovered from non-gratuity dues (same pool
  // as advance recovery). Residual stored in loanResidualNote; corresponding
  // loans are written off with reason "F&F settlement residual".
  @Prop({ default: 0 })
  outstandingLoanAmount: number;

  @Prop({ default: '' })
  loanResidualNote: string;

  // Bonus module (Phase 3A): sum of bonus SalaryAdjustment amounts disbursed
  // within the clawback window at the time F&F is initiated.
  // Deducted from the non-gratuity pool (same priority as advance/loan recovery;
  // applied AFTER advance and loan, fourth in the stack).
  // Gratuity is always protected (Payment of Gratuity Act 1972).
  // Source: SalaryAdjustment rows with category='bonus' where disbursedAt is
  // within clawbackWindowMonths of lastWorkingDate. See BonusService.
  @Prop({ default: 0 })
  bonusClawbackAmount: number;

  @Prop({ type: [Object], default: [] })
  otherAdditions: Array<{
    description: string;
    amount: number;
  }>;

  @Prop({ type: [Object], default: [] })
  otherDeductions: Array<{
    description: string;
    amount: number;
  }>;

  @Prop({ default: 0 })
  totalEarnings: number;

  @Prop({ default: 0 })
  totalDeductions: number;

  @Prop({ default: 0 })
  netFnfPayable: number;

  @Prop({
    enum: ['draft', 'finalised', 'paid'],
    default: 'draft',
  })
  status: 'draft' | 'finalised' | 'paid';

  @Prop({ type: Types.ObjectId })
  finalisedBy: Types.ObjectId;

  @Prop()
  finalisedAt: Date;

  @Prop({ default: '' })
  notes: string;

  @Prop({ type: Types.ObjectId })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  updatedBy: Types.ObjectId;
}

export const FnfSettlementSchema = SchemaFactory.createForClass(FnfSettlement);

FnfSettlementSchema.index({ workspaceId: 1, teamMemberId: 1 }, { unique: true });

FnfSettlementSchema.index({ workspaceId: 1, status: 1 });
