import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { LeaveApprovalStep, LeaveApprovalStepSchema } from './leave-request.schema';

export type CompOffRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * CompOffRequest — a member's claim that they worked a holiday / weekly-off and
 * are owed a comp-off day. On final approval `CompOffService.creditCompOff`
 * mints a `comp_off_credit` lot; `ledgerEntryId` back-links it.
 *
 * The approval chain is snapshotted from `LeaveRequestSettings.approverUserIds`
 * at apply time — the same approvers who action leave requests. An empty chain
 * auto-approves on apply.
 */
@Schema({ timestamps: true, collection: 'compoffrequests' })
export class CompOffRequest extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  appliedBy: Types.ObjectId;

  /** The comp-off `LeaveType` the credited lot lands on. */
  @Prop({ type: Types.ObjectId, ref: 'LeaveType', required: true })
  compOffLeaveTypeId: Types.ObjectId;

  /** The holiday / weekly-off the member worked to earn this comp-off. */
  @Prop({ type: Date, required: true })
  workDate: Date;

  /** Days earned — 1 (full) or 0.5 (half). */
  @Prop({ type: Number, required: true })
  quantity: number;

  @Prop({ type: String, default: null, maxlength: 1000 })
  reason: string | null;

  @Prop({ type: [String], default: [] })
  attachments: string[];

  @Prop({
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
  })
  status: CompOffRequestStatus;

  @Prop({ type: [LeaveApprovalStepSchema], default: [] })
  approvalChain: LeaveApprovalStep[];

  @Prop({ type: Number, default: 1 })
  currentLevel: number;

  @Prop({ type: Date, default: null })
  finalDecisionAt: Date | null;

  /** The `comp_off_credit` ledger entry (lot) minted on approval. */
  @Prop({ type: Types.ObjectId, ref: 'LeaveLedger', default: null })
  ledgerEntryId: Types.ObjectId | null;

  /** Snapshotted lot expiry — `workDate + LeaveType.compOff.validityDays`. */
  @Prop({ type: Date, default: null })
  lotExpiresOn: Date | null;
}

export const CompOffRequestSchema = SchemaFactory.createForClass(CompOffRequest);

// "My comp-off requests" + status filters for a member.
CompOffRequestSchema.index({ workspaceId: 1, teamMemberId: 1, status: 1 });
// Approval queue ordered by the active level.
CompOffRequestSchema.index({ workspaceId: 1, status: 1, currentLevel: 1 });
// Per-member work-date lookup (duplicate-claim check + history).
CompOffRequestSchema.index({ workspaceId: 1, teamMemberId: 1, workDate: -1 });
