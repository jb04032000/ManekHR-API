import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { User } from '../../users/schemas/user.schema';

@Schema({ timestamps: true })
export class Attendance extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: TeamMember | Types.ObjectId;

  @Prop({ required: true, type: Date })
  date: Date; // Store as UTC midnight

  @Prop({
    type: String,
    enum: ['present', 'absent', 'half_day', 'late', 'on_leave', 'holiday', 'week_off'],
    required: true,
  })
  status: string;

  @Prop({ type: Date })
  checkIn?: Date;

  @Prop({ type: Date })
  checkOut?: Date;

  @Prop({ type: String })
  note?: string;

  @Prop({
    type: [
      {
        status: { type: String, required: true },
        changedAt: { type: Date, required: true },
        changedBy: { type: Types.ObjectId, ref: 'User' },
      },
    ],
    default: [],
  })
  statusHistory: {
    status: string;
    changedAt: Date;
    changedBy: Types.ObjectId;
  }[];

  @Prop({ type: Types.ObjectId, ref: 'User' })
  markedBy: User | Types.ObjectId;

  @Prop({ type: Boolean, default: false })
  autoMarked: boolean;

  @Prop({ type: String, default: null })
  dominantSource: string | null;

  @Prop({ type: Date, default: null })
  lastComputedAt: Date | null;

  @Prop({ type: Number, default: 0 })
  projectionVersion: number;

  @Prop({ type: Number, default: null })
  workedMinutes: number | null;

  @Prop({ type: Number, default: null })
  lateMinutes: number | null;

  @Prop({ type: Number, default: null })
  earlyMinutes: number | null;

  @Prop({ type: Number, default: null })
  otMinutes: number | null;

  @Prop({ type: String, default: null })
  computeReason: string | null;
}

export const AttendanceSchema = SchemaFactory.createForClass(Attendance);

AttendanceSchema.index({ workspaceId: 1, teamMemberId: 1, date: 1 }, { unique: true });

// PERF-02 (H6-CONTEXT D-04): date-scoped workspace queries (getSummary, export).
// The unique index above has prefix { workspaceId, teamMemberId } — a date-only query
// would scan all member subsections. This index lets MongoDB answer
// { workspaceId, date } queries with an index range scan (IXSCAN), not COLLSCAN.
AttendanceSchema.index({ workspaceId: 1, date: 1 });
