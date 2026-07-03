import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AttendanceDeviceStatus = 'pending_approval' | 'active' | 'paused' | 'revoked';

@Schema({ timestamps: true })
export class AttendanceDevice extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  wsId: Types.ObjectId;

  @Prop({ type: String, required: true })
  serial: string;

  @Prop({
    type: String,
    enum: ['pending_approval', 'active', 'paused', 'revoked'],
    default: 'pending_approval',
  })
  status: AttendanceDeviceStatus;

  @Prop({
    type: String,
    enum: ['zkteco', 'essl', 'realtime', 'biomax', 'unknown'],
    default: 'unknown',
  })
  vendor: string;

  @Prop({ type: String, default: null })
  alias: string | null;

  @Prop({ type: String, default: null })
  firmwareVersion: string | null;

  @Prop({ type: Date, default: null })
  firstSeenAt: Date | null;

  @Prop({ type: Date, default: null })
  lastSeenAt: Date | null;

  @Prop({ type: Date, default: null })
  lastPendingNotificationAt: Date | null;

  @Prop({
    type: {
      totalEvents: { type: Number, default: 0 },
      lastEventAt: { type: Date, default: null },
    },
    default: { totalEvents: 0, lastEventAt: null },
    _id: false,
  })
  stats: {
    totalEvents: number;
    lastEventAt: Date | null;
  };

  @Prop({
    type: {
      timezone: { type: String, default: 'Asia/Kolkata' },
    },
    default: { timezone: 'Asia/Kolkata' },
    _id: false,
  })
  config: {
    timezone: string;
  };
}

export const AttendanceDeviceSchema = SchemaFactory.createForClass(AttendanceDevice);

// One serial per workspace (device is workspace-scoped)
AttendanceDeviceSchema.index({ wsId: 1, serial: 1 }, { unique: true });
// Status query (admin approval queue)
AttendanceDeviceSchema.index({ wsId: 1, status: 1 });
