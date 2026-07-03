import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * LoanRequest — employee-originated, self-service request for a 0% installment
 * loan. Mirrors the AdvanceSalaryRequest self-service pattern: the employee
 * creates a lightweight request (amount + desired months); later the OWNER
 * approves it and the system materializes a real EmployerLoan
 * (interestType='zero') via the EXISTING LoanService.createLoan, recording the
 * created loan's id on `createdEmployerLoanId`. The EmployerLoan engine and its
 * Separation-of-Duties guard are NOT touched by this layer.
 *
 * The consumer service + endpoints land in Task 2; this schema is the
 * foundation only.
 */

export const LOAN_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

export type LoanRequestStatus = (typeof LOAN_REQUEST_STATUSES)[number];

@Schema({ timestamps: true })
export class LoanRequest extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  // SECURITY: always set server-side from the JWT (Task 2), NEVER from the
  // client body — mirrors AdvanceSalaryRequest.teamMemberId.
  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: Types.ObjectId;

  /** Amount requested in paise (integer, >= 1). Same unit as AdvanceSalaryRequest.requestedAmount. */
  @Prop({ type: Number, required: true, min: 1 })
  requestedAmount: number;

  /** Desired repayment timeline in months (1–120). Final terms are set by the owner at approval. */
  @Prop({ type: Number, required: true, min: 1, max: 120 })
  desiredTenorMonths: number;

  /** Optional free-text reason for the request. */
  @Prop({ type: String, trim: true, maxlength: 500 })
  purpose?: string;

  @Prop({
    type: String,
    enum: LOAN_REQUEST_STATUSES,
    default: 'pending',
    index: true,
  })
  status: LoanRequestStatus;

  /**
   * The EmployerLoan created when an owner APPROVES this request — FK to
   * EmployerLoan. Null until then. Set by the consumer service (Task 2) after
   * LoanService.createLoan materializes the interest-free loan.
   */
  @Prop({ type: Types.ObjectId, ref: 'EmployerLoan', default: null })
  createdEmployerLoanId?: Types.ObjectId | null;

  // ── Who actioned the request (owner approve/reject) ─────────────────────────
  /** Reviewing member (TeamMember) who approved/rejected. */
  @Prop({ type: Types.ObjectId, ref: 'TeamMember' })
  reviewedByTeamMemberId?: Types.ObjectId;

  /** Reviewing user (User) who approved/rejected. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  reviewedByUserId?: Types.ObjectId;

  /** When the request was approved/rejected. */
  @Prop({ type: Date })
  reviewedAt?: Date;

  /** Reason shown to the employee when the request is rejected. */
  @Prop({ type: String })
  rejectionReason?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const LoanRequestSchema = SchemaFactory.createForClass(LoanRequest);

// Efficient member + status lookups within a workspace (own history / owner queue).
LoanRequestSchema.index({ workspaceId: 1, teamMemberId: 1, status: 1 });

// At most ONE pending request per member per workspace. Mirrors the
// AdvanceSalaryRequest per-month dedup partial-unique index pattern: only rows
// matching the partialFilterExpression participate, so approved/rejected/
// cancelled requests do not block a member from filing a fresh one.
LoanRequestSchema.index(
  { workspaceId: 1, teamMemberId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
  },
);

export type LoanRequestDocument = LoanRequest & Document;
