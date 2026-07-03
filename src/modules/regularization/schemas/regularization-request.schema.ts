import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * One step in the approval chain. Snapshotted at request create time
 * (decision timing per D-RESEARCH assumption A3 — snapshot-at-create).
 */
@Schema({ _id: false })
export class ApprovalChainStep {
  @Prop({ type: Number, required: true })
  level: number;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  approverUserId: Types.ObjectId;

  @Prop({ type: String, enum: ['approved', 'rejected', null], default: null })
  decision: 'approved' | 'rejected' | null;

  @Prop({ type: Date, default: null })
  decidedAt: Date | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  note: string | null;
}
export const ApprovalChainStepSchema = SchemaFactory.createForClass(ApprovalChainStep);

/**
 * Reason categories for a correction request. Additive + nullable: legacy rows
 * and free-text-only clients leave it null. Helps approvers triage at a glance
 * (mirrors Keka / GreytHR correction reason types).
 */
export const REGULARIZATION_REASON_CATEGORIES = [
  'MISSING_CHECK_IN',
  'MISSING_CHECK_OUT',
  'WRONG_TIME',
  'FORGOT_PUNCH',
  'OFF_SITE',
  'OTHER',
] as const;
export type RegularizationReasonCategory = (typeof REGULARIZATION_REASON_CATEGORIES)[number];

/**
 * RegularizationRequest: admin-raised correction request for a past attendance day.
 * On full-chain approval, a STATUS_SET AttendanceEvent is written with source='regularization'.
 */
@Schema({ timestamps: true, collection: 'regularizationrequests' })
export class RegularizationRequest extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  wsId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  memberId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  raisedBy: Types.ObjectId;

  @Prop({ type: Date, required: true })
  date: Date; // UTC midnight of the regularized day

  @Prop({ type: String, default: null })
  currentStatus: string | null; // snapshot of Attendance.status at create time

  @Prop({
    type: String,
    enum: ['PRESENT', 'HALF_DAY', 'LEAVE', 'ABSENT'],
    required: true,
  })
  requestedStatus: 'PRESENT' | 'HALF_DAY' | 'LEAVE' | 'ABSENT';

  @Prop({ type: Date, default: null })
  requestedCheckIn: Date | null;

  @Prop({ type: Date, default: null })
  requestedCheckOut: Date | null;

  @Prop({ type: String, required: true, minlength: 10, maxlength: 500 })
  reason: string;

  // Optional reason category (additive; null on legacy rows + free-text-only clients).
  @Prop({ type: String, enum: [...REGULARIZATION_REASON_CATEGORIES, null], default: null })
  reasonCategory: RegularizationReasonCategory | null;

  @Prop({ type: [String], default: [] })
  attachments: string[]; // R2 URLs (reuse existing uploads module)

  @Prop({
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
  })
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';

  @Prop({ type: [ApprovalChainStepSchema], default: [] })
  approvalChain: ApprovalChainStep[];

  @Prop({ type: Number, default: 1 })
  currentLevel: number;

  @Prop({ type: Date, default: null })
  finalDecisionAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'AttendanceEvent', default: null })
  resultingEventId: Types.ObjectId | null;

  @Prop({ type: Boolean, default: false })
  salaryInvalidated: boolean;
}

export const RegularizationRequestSchema = SchemaFactory.createForClass(RegularizationRequest);

// DD-11: one pending request per (wsId, memberId, date). Rejected/cancelled rows
// are excluded by partialFilterExpression so re-raise is unlimited.
RegularizationRequestSchema.index(
  { wsId: 1, memberId: 1, date: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
// "Pending for me" query uses currentLevel to pick the active approver.
RegularizationRequestSchema.index({ wsId: 1, status: 1, currentLevel: 1 });
// Index supports `.approvalChain.approverUserId` lookups when combined with status=pending.
RegularizationRequestSchema.index({
  wsId: 1,
  status: 1,
  'approvalChain.approverUserId': 1,
});
// "My requests" list for a member ordered most-recent first.
RegularizationRequestSchema.index({ wsId: 1, memberId: 1, createdAt: -1 });
// "Raised by me" list for a user.
RegularizationRequestSchema.index({ wsId: 1, raisedBy: 1, createdAt: -1 });
