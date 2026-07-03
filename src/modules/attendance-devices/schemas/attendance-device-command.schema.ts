import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AttendanceDeviceCommand extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  wsId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'AttendanceDevice', required: true })
  deviceId: Types.ObjectId;

  @Prop({ type: String, required: true })
  serial: string;

  // Raw ADMS command string e.g. "DATA UPDATE USER PIN=1001\tName=John"
  @Prop({ type: String, required: true })
  commandText: string;

  @Prop({
    type: String,
    enum: ['queued', 'sent', 'acknowledged', 'failed'],
    default: 'queued',
  })
  status: string;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  @Prop({ type: Date, default: null })
  acknowledgedAt: Date | null;
}

export const AttendanceDeviceCommandSchema = SchemaFactory.createForClass(AttendanceDeviceCommand);

// Ingest controller dequeue: find queued commands for a given serial+wsId
AttendanceDeviceCommandSchema.index({ wsId: 1, serial: 1, status: 1 });
