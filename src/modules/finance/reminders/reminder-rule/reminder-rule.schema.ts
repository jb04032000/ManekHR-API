import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'reminder_rules' })
export class ReminderRule extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  /** null = global rule (applies to all parties in firm) */
  @Prop({ type: Types.ObjectId, index: true })
  partyId?: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 100 })
  name: string;

  @Prop({ type: String, trim: true, maxlength: 500 })
  description?: string;

  @Prop({
    type: String,
    enum: ['invoice_overdue', 'invoice_due_soon', 'service_maintenance'],
    required: true,
  })
  triggerType: string;

  /** negative = before due date, positive = after due date */
  @Prop({ type: Number, required: true })
  daysOffset: number;

  @Prop({ type: Number, default: 1, min: 1, max: 3 })
  escalationLevel: number;

  @Prop({ type: Number, default: 24, min: 1 })
  cooldownHours: number;

  @Prop({ type: Boolean, default: true })
  channelInApp: boolean;

  @Prop({ type: Boolean, default: true })
  channelEmail: boolean;

  /** SMS default false — India DLT (TRAI 2025) compliance */
  @Prop({ type: Boolean, default: false })
  channelSms: boolean;

  /** Push default false — no FCM tokens registered yet */
  @Prop({ type: Boolean, default: false })
  channelPush: boolean;

  /** WhatsApp default false — AiSensy template approval pending */
  @Prop({ type: Boolean, default: false })
  channelWhatsApp: boolean;

  @Prop({ type: String })
  emailTemplateKey?: string;

  @Prop({ type: String })
  smsTemplateKey?: string;

  @Prop({ type: String })
  whatsAppCampaignName?: string;

  @Prop({ type: Number, default: 0 })
  priority: number;

  @Prop({ type: Boolean, default: true, index: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const ReminderRuleSchema = SchemaFactory.createForClass(ReminderRule);

/** Compound index for fast dispatcher lookup */
ReminderRuleSchema.index({
  workspaceId: 1,
  firmId: 1,
  partyId: 1,
  triggerType: 1,
  daysOffset: 1,
});
