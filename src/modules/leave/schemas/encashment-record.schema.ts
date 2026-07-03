import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EncashmentTrigger = 'annual' | 'fnf';
export type EncashmentStatus = 'pending' | 'consumed';

/**
 * EncashmentRecord — the event-decoupled bridge between leave and payroll. The
 * leave module emits encashable `days`; the salary/FNF module reads pending
 * records, monetizes them, and stamps `consumedBySalaryId`. Leave never writes
 * salary data — there is no schema FK from salary into the leave module.
 */
@Schema({ timestamps: true, collection: 'encashmentrecords' })
export class EncashmentRecord extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LeaveType', required: true })
  leaveTypeId: Types.ObjectId;

  @Prop({ type: Number, required: true })
  year: number;

  @Prop({ type: Number, required: true })
  days: number;

  @Prop({ type: String, enum: ['annual', 'fnf'], required: true })
  trigger: EncashmentTrigger;

  @Prop({ type: String, enum: ['pending', 'consumed'], default: 'pending' })
  status: EncashmentStatus;

  /** Set by the salary module when the encashment is paid out. */
  @Prop({ type: Types.ObjectId, ref: 'Salary', default: null })
  consumedBySalaryId: Types.ObjectId | null;

  /** The `encashment` `LeaveLedger` debit that produced this record. */
  @Prop({ type: Types.ObjectId, ref: 'LeaveLedger', default: null })
  sourceLedgerEntryId: Types.ObjectId | null;
}

export const EncashmentRecordSchema = SchemaFactory.createForClass(EncashmentRecord);

// Pending-encashment lookup for the salary/FNF module.
EncashmentRecordSchema.index({ workspaceId: 1, teamMemberId: 1, status: 1 });
// Dedup / audit lookup per member × type × year × trigger.
EncashmentRecordSchema.index({
  workspaceId: 1,
  teamMemberId: 1,
  leaveTypeId: 1,
  year: 1,
  trigger: 1,
});
