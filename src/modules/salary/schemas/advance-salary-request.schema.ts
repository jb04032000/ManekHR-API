import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export const ADVANCE_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'paid',
  'cancelled',
] as const;

export type AdvanceRequestStatus = (typeof ADVANCE_REQUEST_STATUSES)[number];

@Schema({ timestamps: true })
export class AdvanceSalaryRequest extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true, index: true })
  teamMemberId: Types.ObjectId;

  /** 1–12: the CURRENT month the advance is requested against */
  @Prop({ type: Number, required: true })
  month: number;

  @Prop({ type: Number, required: true })
  year: number;

  /** Amount in paise (integer) */
  @Prop({ type: Number, required: true })
  requestedAmount: number;

  /** Paise; set by owner at approval time */
  @Prop({ type: Number })
  approvedAmount?: number;

  @Prop({
    type: String,
    enum: ADVANCE_REQUEST_STATUSES,
    default: 'pending',
    index: true,
  })
  status: AdvanceRequestStatus;

  /** UTC timestamp — use new Date(Date.UTC(...)) at write time per RESEARCH Pitfall 7 */
  @Prop({ type: Date, required: true })
  requestedOn: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  requestedBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  reviewedBy?: Types.ObjectId;

  @Prop({ type: Date })
  reviewedOn?: Date;

  @Prop({ type: String })
  reviewNote?: string;

  // ── Reporting-person review (Phase 3a) — ADVISORY ───────────────────────────
  // Set when the requester's reporting person (their TeamMember.reportsTo
  // manager, holding salary.review_advance) verifies the request. Advisory only:
  // these fields are decoupled from `status` and the owner approve/reject/pay
  // lifecycle — verifying NEVER changes status or gates the owner. Additive +
  // nullable, so no migration is needed. Links: advance-salary-request.service.ts
  // verifyRequest, advance-salary-request.controller.ts PATCH :requestId/verify.

  /** Reviewer (reporting person) who verified the request — FK to User. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  verifiedBy?: Types.ObjectId;

  /** When the reporting person verified the request. */
  @Prop({ type: Date })
  verifiedAt?: Date;

  /** Optional advisory note the reporting person left while verifying. */
  @Prop({ type: String })
  verifyNote?: string;

  /** Set when status transitions to 'paid' — FK to Payment */
  @Prop({ type: Types.ObjectId, ref: 'Payment' })
  paymentId?: Types.ObjectId;

  /**
   * Set when next-month deduction adjustment is applied — FK to SalaryAdjustment.
   * Plan 03 reads/writes this field during advance recovery deduction.
   *
   * PAYROLL-CRITICAL: also stamped at DISBURSE time when a single lump
   * recovery deduction is created (payApprovedAdvance / approveAndDisburse), so
   * the salary-generation safety net `applyAdvanceAutoDeductions` skips an
   * advance that already has an explicit recovery and cannot double-recover it.
   */
  @Prop({ type: Types.ObjectId, ref: 'SalaryAdjustment' })
  recoveryAdjustmentId?: Types.ObjectId;

  /**
   * Set at DISBURSE time when a MULTI-INSTALLMENT recovery plan is created — FK
   * to AdvanceRecoveryPlan. Like recoveryAdjustmentId, it marks the request as
   * already having an explicit recovery so `applyAdvanceAutoDeductions` skips
   * it (the auto-deduct safety net only fires for paid advances with NEITHER
   * marker set). Additive + nullable — no migration needed.
   */
  @Prop({ type: Types.ObjectId, ref: 'AdvanceRecoveryPlan' })
  recoveryPlanId?: Types.ObjectId;

  /**
   * Set at DISBURSE time when the advance settles against the REQUEST MONTH'S
   * OWN salary (owner model 2026-07-03: an advance is part of that month's pay
   * given early). No SalaryAdjustment/plan is created — the advance Payment
   * itself counts toward that month's paid amount, so payroll's "remaining" is
   * already net-of-advance. The flag marks the request as explicitly recovered
   * so `applyAdvanceAutoDeductions` never lump-deducts it in a later month
   * (which would recover it twice). Additive + nullable — no migration needed.
   */
  @Prop({ type: Boolean })
  sameMonthRecovery?: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const AdvanceSalaryRequestSchema = SchemaFactory.createForClass(AdvanceSalaryRequest);

// D-09: one active request per (workspace, member, month, year)
// Cancelled and rejected requests are excluded so a member can re-request after rejection.
AdvanceSalaryRequestSchema.index(
  { workspaceId: 1, teamMemberId: 1, month: 1, year: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['pending', 'approved', 'paid'] } },
  },
);

// Efficient owner queue listing by workspace + status
AdvanceSalaryRequestSchema.index({ workspaceId: 1, status: 1 });

// Member's own request history
AdvanceSalaryRequestSchema.index({ workspaceId: 1, teamMemberId: 1 });

export type AdvanceSalaryRequestDocument = AdvanceSalaryRequest & Document;
