import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AnomalyRuleType =
  | 'unknown_sn'
  | 'rapid_dup'
  | 'missed_streak'
  | 'off_shift_punch'
  | 'time_travel'
  | 'binding_conflict'
  | 'locked_payroll_push';

export type AnomalySeverity = 'high' | 'medium' | 'low';

@Schema({ timestamps: true })
export class Anomaly extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  wsId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: [
      'unknown_sn',
      'rapid_dup',
      'missed_streak',
      'off_shift_punch',
      'time_travel',
      'binding_conflict',
      'locked_payroll_push',
    ],
  })
  ruleType: AnomalyRuleType;

  @Prop({ type: String, required: true, enum: ['high', 'medium', 'low'] })
  severity: AnomalySeverity;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', default: null })
  teamMemberId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  deviceSerial: string | null;

  @Prop({ type: Object, required: true })
  context: Record<string, unknown>;

  @Prop({ type: String, default: null })
  contextKey: string | null;

  @Prop({ type: Boolean, default: false })
  acknowledged: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  acknowledgedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  acknowledgedAt: Date | null;

  @Prop({ type: Date, default: null })
  emailDispatchedAt: Date | null;
}

export const AnomalySchema = SchemaFactory.createForClass(Anomaly);

// Primary feed query: unacknowledged first, newest first, scoped by workspace
AnomalySchema.index({ wsId: 1, acknowledged: 1, createdAt: -1 });

// Email de-dupe / record de-dupe for unknown_sn
AnomalySchema.index({ wsId: 1, ruleType: 1, contextKey: 1, emailDispatchedAt: -1 });

// 24h dashboard widget count + general recency
AnomalySchema.index({ wsId: 1, createdAt: -1 });

// Dedup index: covers AnomaliesService.record() contextual dedup query
// { wsId, ruleType, contextKey, acknowledged: false } in record()
AnomalySchema.index({ wsId: 1, ruleType: 1, contextKey: 1, acknowledged: 1 });
