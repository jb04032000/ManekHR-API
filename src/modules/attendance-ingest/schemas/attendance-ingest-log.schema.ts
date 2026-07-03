import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AttendanceIngestLog extends Document {
  @Prop({ type: Types.ObjectId, default: null })
  wsId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  deviceSerial: string | null;

  @Prop({ type: String, required: true })
  method: string; // 'GET' | 'POST'

  @Prop({ type: String, default: null })
  table: string | null; // 'ATTLOG' | 'USER' | 'OPERLOG' | null

  @Prop({ type: Number, default: 0 })
  bodyBytes: number;

  @Prop({ type: Number, required: true })
  responseStatus: number; // 200 | 403 | 413 | 429

  @Prop({ type: String, default: null })
  error: string | null; // short error descriptor if any

  @Prop({ type: Date, default: () => new Date() })
  createdAt: Date;
}

export const AttendanceIngestLogSchema =
  SchemaFactory.createForClass(AttendanceIngestLog);

// TTL: auto-delete records older than 30 days
AttendanceIngestLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 2592000 },
);

// Operational query: recent logs per workspace or per device
AttendanceIngestLogSchema.index({ wsId: 1, createdAt: -1 });
