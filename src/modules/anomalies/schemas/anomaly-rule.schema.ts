import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import type { AnomalyRuleType } from './anomaly.schema';

@Schema({ timestamps: true })
export class AnomalyRule extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  wsId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: ['unknown_sn', 'rapid_dup', 'missed_streak', 'off_shift_punch', 'time_travel'],
  })
  ruleType: AnomalyRuleType;

  @Prop({ type: Boolean, default: true })
  enabled: boolean;

  // Future-facing fields — stored but not exposed in Phase I UI per DI-04
  @Prop({ type: Number, default: null })
  thresholdCount: number | null;

  @Prop({ type: Number, default: null })
  thresholdMinutes: number | null;
}

export const AnomalyRuleSchema = SchemaFactory.createForClass(AnomalyRule);

// One rule row per workspace per ruleType
AnomalyRuleSchema.index({ wsId: 1, ruleType: 1 }, { unique: true });
