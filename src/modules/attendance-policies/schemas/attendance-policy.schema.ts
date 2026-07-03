import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class AttendancePolicy extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  wsId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ default: false })
  isDefault: boolean;

  @Prop({
    type: {
      countAsLop: { type: Boolean, default: false },
      lopAfterNLateDays: { type: Number, default: null },
    },
    default: () => ({ countAsLop: false, lopAfterNLateDays: null }),
    _id: false,
  })
  lateArrival: { countAsLop: boolean; lopAfterNLateDays: number | null };

  @Prop({
    type: {
      enabled: { type: Boolean, default: false },
      thresholdMinutes: { type: Number, default: 30 },
      countAsHalfDay: { type: Boolean, default: false },
    },
    default: () => ({ enabled: false, thresholdMinutes: 30, countAsHalfDay: false }),
    _id: false,
  })
  earlyDeparture: { enabled: boolean; thresholdMinutes: number; countAsHalfDay: boolean };

  @Prop({
    type: {
      enabled: { type: Boolean, default: false },
      thresholdMinutes: { type: Number, default: 30 },
      capMinutes: { type: Number, default: null },
    },
    default: () => ({ enabled: false, thresholdMinutes: 30, capMinutes: null }),
    _id: false,
  })
  ot: { enabled: boolean; thresholdMinutes: number; capMinutes: number | null };

  @Prop({
    type: { enabled: { type: Boolean, default: false } },
    default: () => ({ enabled: false }),
    _id: false,
  })
  compOff: { enabled: boolean };
}

export const AttendancePolicySchema = SchemaFactory.createForClass(AttendancePolicy);

// Workspace scoping: list all policies for a workspace
AttendancePolicySchema.index({ wsId: 1 });
// Fast default-policy lookup (used at compute time per DC-1)
AttendancePolicySchema.index({ wsId: 1, isDefault: 1 });
