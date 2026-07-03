import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AttendanceEvent extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  wsId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', default: null })
  teamMemberId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  deviceSerial: string | null;

  @Prop({ type: String, default: null })
  deviceUserId: string | null;

  @Prop({ type: Date, required: true })
  timestamp: Date;

  @Prop({
    type: String,
    required: true,
    enum: ['CHECK_IN', 'CHECK_OUT', 'BREAK_OUT', 'BREAK_IN', 'OT_IN', 'OT_OUT', 'STATUS_SET'],
  })
  punchType: string;

  @Prop({ type: String, default: null })
  statusValue: string | null;

  @Prop({
    type: String,
    enum: ['fp', 'face', 'card', 'password', 'palm', 'manual', 'auto', 'kiosk', null],
    default: null,
  })
  verifyMethod: string | null;

  @Prop({
    type: String,
    required: true,
    enum: [
      'manual',
      'manual_override',
      'device_push',
      'connector',
      'file_upload',
      'auto_cron',
      'regularization',
      'kiosk',
      'self',
      'leave',
    ],
  })
  source: string;

  @Prop({ type: Object, default: null })
  sourceMeta: Record<string, unknown> | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  markedBy: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  note: string | null;

  @Prop({ type: String, default: null })
  importHash: string | null;

  @Prop({ type: Types.ObjectId, ref: 'AttendanceEvent', default: null })
  correctsEventId: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  voidedBy: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  voidReason: string | null;

  /**
   * The attendance date this event belongs to — always the shift-start calendar day
   * (UTC midnight). Separate from `timestamp` so cross-midnight checkouts (e.g. 08:30
   * on Day 2 for a night shift that started at 20:30 on Day 1) are correctly grouped
   * under Day 1's attendance record. Null on legacy events created before this field
   * was introduced; the one-time migration script backfills those.
   */
  @Prop({ type: Date, default: null })
  attendanceDate: Date | null;
}

export const AttendanceEventSchema = SchemaFactory.createForClass(AttendanceEvent);

// Primary query path (wsId + member + timestamp)
AttendanceEventSchema.index({ wsId: 1, teamMemberId: 1, timestamp: 1 });

// Cross-midnight shift query path — findByMemberDate uses attendanceDate when set
AttendanceEventSchema.index({ wsId: 1, teamMemberId: 1, attendanceDate: 1 });

// Audit trail
AttendanceEventSchema.index({ wsId: 1, createdAt: -1 });

// Biometric dedupe — unique partial index (only when deviceSerial is set)
AttendanceEventSchema.index(
  { wsId: 1, deviceSerial: 1, deviceUserId: 1, timestamp: 1 },
  {
    unique: true,
    partialFilterExpression: { deviceSerial: { $type: 'string' } },
  },
);

// File-upload dedupe — partial unique (only indexes docs where importHash is a string).
// NOTE: do NOT combine sparse:true with partialFilterExpression — MongoDB rejects that.
// partialFilterExpression { importHash: { $type: 'string' } } achieves the same sparse
// semantics by skipping documents where importHash is null/missing.
AttendanceEventSchema.index(
  { wsId: 1, importHash: 1 },
  {
    unique: true,
    partialFilterExpression: { importHash: { $type: 'string' } },
    background: true,
  },
);
