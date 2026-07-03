import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

// ---------------------------------------------------------------------------
// Enums / constants
// ---------------------------------------------------------------------------

export const LOAN_TYPES = [
  'personal',
  'medical',
  'housing',
  'vehicle',
  'education',
  'other',
] as const;

export type LoanType = (typeof LOAN_TYPES)[number];

export const INTEREST_TYPES = ['zero', 'flat', 'reducing_balance'] as const;

export type InterestType = (typeof INTEREST_TYPES)[number];

export const LOAN_STATUSES = [
  'draft',
  'pending_approval',
  'active',
  'paused',
  'completed',
  'written_off',
  'reversed',
] as const;

export type LoanStatus = (typeof LOAN_STATUSES)[number];

// top_up_superseded: old loan closed when a top-up recomputes the schedule
export const LOAN_CLOSURE_TYPES = [
  'completed',
  'early_payoff',
  'written_off',
  'reversed',
  'top_up_superseded',
] as const;

export type LoanClosureType = (typeof LOAN_CLOSURE_TYPES)[number];

// 'skipped' is new vs advance: owner explicitly skips a month;
// installment is not reversed, just bypassed with knock-on choice
export const LOAN_INSTALLMENT_STATUSES = [
  'scheduled',
  'applied',
  'reversed',
  'skipped',
  'carried',
] as const;

export type LoanInstallmentStatus = (typeof LOAN_INSTALLMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Sub-document shapes (not decorated - used as embedded type annotations)
// ---------------------------------------------------------------------------

export type LoanInstallment = {
  index: number;
  month: number;
  year: number;
  /** portion of this installment going to principal repayment */
  principalPlanned: number;
  /** interest for this installment (0 when interestType=zero) */
  interestPlanned: number;
  /** principalPlanned + interestPlanned */
  emiPlanned: number;
  /** actual amount deducted (after cap-and-carry) */
  appliedAmount: number;
  adjustmentId?: Types.ObjectId;
  status: LoanInstallmentStatus;
  skipReason?: string;
  knockOnChoice?: 'extend_tenor' | 'raise_emi';
};

export type ApprovalStep = {
  stepIndex: number;
  approverId: Types.ObjectId;
  /** denormalized for display after member leaves the workspace */
  approverName: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: Date;
  comment?: string;
};

export type TopUpEntry = {
  topUpDate: Date;
  additionalAmount: number;
  newPrincipal: number;
  newEmi: number;
  newTenor: number;
  newEndDate: Date;
  createdBy: Types.ObjectId;
  /** previous plan archived with closureType=top_up_superseded */
  supersededPlanSnapshotId?: Types.ObjectId;
};

export type PerquisiteEntry = {
  month: number;
  year: number;
  /** loan balance at the start of the month (IT rules: max monthly balance) */
  outstandingAtStart: number;
  /** SBI benchmark rate in effect at computation time (stored for immutable history) */
  sbiBenchmarkRate: number;
  interestActuallyCharged: number;
  /** = outstandingAtStart * (sbiBenchmarkRate - actualRate) / 1200 */
  perquisiteValue: number;
  /** true when medical loan or aggregate outstanding <= Rs 2,00,000 exemption */
  exempt: boolean;
  adjustmentId?: Types.ObjectId;
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

@Schema({ timestamps: true })
export class EmployerLoan extends Document {
  // ------------------------------------------------------------------
  // Workspace + member identity
  // ------------------------------------------------------------------

  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: Types.ObjectId;

  // ------------------------------------------------------------------
  // Loan classification
  // ------------------------------------------------------------------

  @Prop({ type: String, enum: LOAN_TYPES, required: true })
  loanType: LoanType;

  // ------------------------------------------------------------------
  // Disbursement
  // ------------------------------------------------------------------

  /** total amount disbursed to the employee */
  @Prop({ required: true, min: 1 })
  principalAmount: number;

  /** false = disbursed via in-app Payment record; true = cash/bank outside app */
  @Prop({ type: Boolean, default: false })
  disbursedOutsideApp: boolean;

  /** date the money left the employer */
  @Prop({ type: Date, required: true })
  disbursementDate: Date;

  /** populated only when disbursedOutsideApp = false */
  @Prop({ type: Types.ObjectId, ref: 'Payment' })
  disbursementPaymentId?: Types.ObjectId;

  /** reference number for outside-app disbursements (cheque/NEFT/IMPS ref) */
  @Prop({ type: String })
  disbursementReferenceNo?: string;

  /** free-text note about the disbursement */
  @Prop({ type: String })
  disbursementNote?: string;

  // ------------------------------------------------------------------
  // Interest configuration
  // ------------------------------------------------------------------

  @Prop({ type: String, enum: INTEREST_TYPES, required: true })
  interestType: InterestType;

  /** 0 when interestType=zero; annual percentage rate */
  @Prop({ required: true, min: 0 })
  annualInterestRate: number;

  // ------------------------------------------------------------------
  // Schedule parameters
  // ------------------------------------------------------------------

  @Prop({ required: true, min: 1, max: 120 })
  tenorMonths: number;

  /** computed EMI amount at creation; re-computed on top-up or skip with raise_emi */
  @Prop({ required: true, min: 0 })
  emiAmount: number;

  @Prop({ required: true, min: 1, max: 12 })
  startMonth: number;

  @Prop({ required: true })
  startYear: number;

  // ------------------------------------------------------------------
  // Running balances
  // ------------------------------------------------------------------

  @Prop({ type: String, enum: LOAN_STATUSES, default: 'draft', index: true })
  status: LoanStatus;

  /** cumulative amount recovered so far */
  @Prop({ type: Number, default: 0 })
  recoveredAmount: number;

  /**
   * for reducing-balance: remaining principal (principal component not yet recovered).
   * for flat-rate/zero: mirrors remainingAmount.
   */
  @Prop({ type: Number, default: 0 })
  remainingPrincipal: number;

  /** total outstanding = principal + scheduled interest still due */
  @Prop({ type: Number, default: 0 })
  remainingAmount: number;

  /** sum of interest column across the full amortization schedule */
  @Prop({ type: Number, default: 0 })
  totalInterestScheduled: number;

  /** interest actually paid to date (running sum of interestPlanned for applied installments) */
  @Prop({ type: Number, default: 0 })
  interestPaidToDate: number;

  // ------------------------------------------------------------------
  // Installments sub-document array
  // ------------------------------------------------------------------

  @Prop({
    type: [
      {
        index: { type: Number },
        month: { type: Number },
        year: { type: Number },
        principalPlanned: { type: Number },
        interestPlanned: { type: Number },
        emiPlanned: { type: Number },
        appliedAmount: { type: Number, default: 0 },
        adjustmentId: { type: Types.ObjectId, ref: 'SalaryAdjustment' },
        status: {
          type: String,
          enum: LOAN_INSTALLMENT_STATUSES,
          default: 'scheduled',
        },
        skipReason: { type: String },
        knockOnChoice: { type: String, enum: ['extend_tenor', 'raise_emi'] },
        _id: false,
      },
    ],
    default: [],
  })
  installments: LoanInstallment[];

  /** all SalaryAdjustment IDs (loan_recovery deductions) linked to this loan */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'SalaryAdjustment' }], default: [] })
  linkedAdjustmentIds: Types.ObjectId[];

  // ------------------------------------------------------------------
  // Approval chain sub-document array
  // ------------------------------------------------------------------

  @Prop({
    type: [
      {
        stepIndex: { type: Number },
        approverId: { type: Types.ObjectId, ref: 'User' },
        approverName: { type: String },
        status: {
          type: String,
          enum: ['pending', 'approved', 'rejected'],
          default: 'pending',
        },
        decidedAt: { type: Date },
        comment: { type: String },
        _id: false,
      },
    ],
    default: [],
  })
  approvalChain: ApprovalStep[];

  /** set when the final approver approves */
  @Prop({ type: Date })
  approvedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  approvedBy?: Types.ObjectId;

  // ------------------------------------------------------------------
  // Pause fields
  // ------------------------------------------------------------------

  @Prop({ type: Types.ObjectId, ref: 'User' })
  pausedBy?: Types.ObjectId;

  @Prop({ type: Date })
  pausedAt?: Date;

  /** if set, the cron will auto-resume the loan on this date */
  @Prop({ type: Date })
  pauseResumeDate?: Date;

  // ------------------------------------------------------------------
  // Closure fields
  // ------------------------------------------------------------------

  @Prop({ type: Types.ObjectId, ref: 'User' })
  closedBy?: Types.ObjectId;

  @Prop({ type: Date })
  closedAt?: Date;

  @Prop({ type: String, enum: LOAN_CLOSURE_TYPES })
  closureType?: LoanClosureType;

  @Prop({ type: String })
  closureReason?: string;

  /** amount written off (populated when closureType=written_off) */
  @Prop({ type: Number })
  writeOffAmount?: number;

  // ------------------------------------------------------------------
  // Top-up history sub-document array
  // ------------------------------------------------------------------

  @Prop({
    type: [
      {
        topUpDate: { type: Date },
        additionalAmount: { type: Number },
        newPrincipal: { type: Number },
        newEmi: { type: Number },
        newTenor: { type: Number },
        newEndDate: { type: Date },
        createdBy: { type: Types.ObjectId, ref: 'User' },
        supersededPlanSnapshotId: { type: Types.ObjectId, ref: 'EmployerLoan' },
        _id: false,
      },
    ],
    default: [],
  })
  topUpHistory: TopUpEntry[];

  // ------------------------------------------------------------------
  // Compliance / perquisite fields
  // ------------------------------------------------------------------

  /**
   * true for medical loans: exempt from perquisite valuation under IT Rule 3(7)(i).
   * also exempted when the aggregate outstanding across all employer loans for
   * the member in the FY does not exceed Rs 2,00,000.
   */
  @Prop({ type: Boolean, default: false })
  medicalLoanExempt: boolean;

  /**
   * monthly perquisite computation log; one entry per processed month.
   * idempotent: computeMonthlyPerquisites checks for an existing entry before writing.
   */
  @Prop({
    type: [
      {
        month: { type: Number },
        year: { type: Number },
        outstandingAtStart: { type: Number },
        sbiBenchmarkRate: { type: Number },
        interestActuallyCharged: { type: Number },
        perquisiteValue: { type: Number },
        exempt: { type: Boolean },
        adjustmentId: { type: Types.ObjectId, ref: 'SalaryAdjustment' },
        _id: false,
      },
    ],
    default: [],
  })
  perquisiteHistory: PerquisiteEntry[];

  // ------------------------------------------------------------------
  // Audit trail
  // ------------------------------------------------------------------

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  // Mongoose auto-managed
  createdAt?: Date;
  updatedAt?: Date;
}

export const EmployerLoanSchema = SchemaFactory.createForClass(EmployerLoan);

export type EmployerLoanDocument = EmployerLoan & Document;

// ---------------------------------------------------------------------------
// Atlas indexes
// ---------------------------------------------------------------------------

/** primary query: workspace + member + status (list member's loans, dashboard) */
EmployerLoanSchema.index({ workspaceId: 1, teamMemberId: 1, status: 1 });

/** loan dashboard: workspace + status + type filter */
EmployerLoanSchema.index({ workspaceId: 1, status: 1, loanType: 1 });

/** chronological disbursement listing per workspace */
EmployerLoanSchema.index({ workspaceId: 1, disbursementDate: -1 });

/**
 * auto-resume cron query: paused loans with a past pauseResumeDate.
 * partial index - only indexes documents where pauseResumeDate is set.
 */
EmployerLoanSchema.index(
  { status: 1, pauseResumeDate: 1 },
  { partialFilterExpression: { status: 'paused', pauseResumeDate: { $exists: true } } },
);
