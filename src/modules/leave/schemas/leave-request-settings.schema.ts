import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * LeaveRequestSettings — one workspace-scoped config row for the leave-request
 * workflow. Created on first read with schema defaults.
 *
 * `approverUserIds` is an explicit ordered approver chain (level 1, 2, …) —
 * snapshotted onto each request at apply time. An empty list means a request
 * needs no approval.
 */
@Schema({ timestamps: true, collection: 'leaverequestsettings' })
export class LeaveRequestSettings extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, unique: true })
  workspaceId: Types.ObjectId;

  /** Ordered approval chain — one approver per level. Empty → auto-approve. */
  @Prop({ type: [Types.ObjectId], ref: 'User', default: [] })
  approverUserIds: Types.ObjectId[];

  /** When true, weekly-offs / holidays inside a leave span are also charged. */
  @Prop({ type: Boolean, default: false })
  sandwichLeave: boolean;

  /** How far back (days) a retroactive past-dated request may reach. */
  @Prop({ type: Number, default: 30 })
  retroMaxDaysBack: number;

  /** Hard cap on attachments per leave request. */
  @Prop({ type: Number, default: 5 })
  maxAttachmentsPerRequest: number;
}

export const LeaveRequestSettingsSchema = SchemaFactory.createForClass(LeaveRequestSettings);
