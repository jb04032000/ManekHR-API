import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'machine_shift_assignments' })
export class MachineShiftAssignment extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Machine', required: true, index: true })
  machineId: Types.ObjectId;

  // Optional: single-shift workspaces can assign operators without a shift.
  @Prop({ type: Types.ObjectId, ref: 'Shift', index: true })
  shiftId?: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'TeamMember',
    required: true,
    index: true,
  })
  teamMemberId: Types.ObjectId;

  @Prop({ type: Date, required: true, index: true })
  effectiveFrom: Date;

  // null = ongoing / no end.
  @Prop({ type: Date })
  effectiveTo?: Date;

  // Primary operator vs helper/backup. MVP = single primary per machine+shift.
  @Prop({ type: Boolean, default: true })
  isPrimary: boolean;

  // Optional daily hours (HH:mm) that this assignment covers — only
  // meaningful when no shift is set. Lets admin specify e.g. "Worker
  // operates this machine 10:00-14:00" even when the worker has no
  // customSchedule on their team profile. Leave empty to fall back to
  // worker.customSchedule; still empty => full-day coverage.
  @Prop({ type: String })
  startTime?: string;

  @Prop({ type: String })
  endTime?: string;

  @Prop({ trim: true, maxlength: 200 })
  notes?: string;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;
}

export const MachineShiftAssignmentSchema = SchemaFactory.createForClass(
  MachineShiftAssignment,
);

// Common queries: assignments for a machine / for a worker.
MachineShiftAssignmentSchema.index({
  workspaceId: 1,
  machineId: 1,
  effectiveFrom: -1,
});
MachineShiftAssignmentSchema.index({
  workspaceId: 1,
  teamMemberId: 1,
  effectiveFrom: -1,
});
// Overlap detection helper index (overlap enforcement is service-level).
MachineShiftAssignmentSchema.index({
  workspaceId: 1,
  machineId: 1,
  shiftId: 1,
  isPrimary: 1,
  isDeleted: 1,
});
