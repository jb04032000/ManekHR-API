import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * LeaveApproverDelegation — an approver hands their leave / comp-off approval
 * authority to a delegate for a coverage window (e.g. while on leave
 * themselves). During the window the delegate may action any request where the
 * delegating approver is the current-level approver.
 *
 * The window is an inclusive UTC-midnight `[startsOn, endsOn]` range; the live
 * check compares the as-of *day* against it.
 */
@Schema({ timestamps: true, collection: 'leaveapproverdelegations' })
export class LeaveApproverDelegation extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  /** The approver delegating their authority — also the creator / revoker. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  fromUserId: Types.ObjectId;

  /** The delegate who may act in the approver's place. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  toUserId: Types.ObjectId;

  /** Inclusive UTC-midnight coverage window. */
  @Prop({ type: Date, required: true })
  startsOn: Date;

  @Prop({ type: Date, required: true })
  endsOn: Date;

  @Prop({ type: String, default: null, maxlength: 500 })
  reason: string | null;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  revokedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;
}

export const LeaveApproverDelegationSchema = SchemaFactory.createForClass(LeaveApproverDelegation);

// Live-delegation lookup during an approval identity check.
LeaveApproverDelegationSchema.index({
  workspaceId: 1,
  fromUserId: 1,
  toUserId: 1,
  isActive: 1,
});
// Delegation roster + per-delegator overlap check.
LeaveApproverDelegationSchema.index({ workspaceId: 1, fromUserId: 1, isActive: 1 });
