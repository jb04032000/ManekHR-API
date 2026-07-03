import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'reminder_settings' })
export class ReminderSettings extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  /** One settings document per firm — enforced via UNIQUE index */
  @Prop({ type: Types.ObjectId, required: true, unique: true })
  firmId: Types.ObjectId;

  @Prop({ type: Boolean, default: true })
  enabled: boolean;

  /**
   * HH:MM IST — informational for Wave 4 UI.
   * MVP cron is fixed at 07:30 IST (CRON_SCHEDULES.REMINDER_DISPATCHER).
   */
  @Prop({ type: String, default: '08:00' })
  dispatchTime: string;

  @Prop({ type: String })
  fromName?: string;

  /** Minimum outstanding balance in paise to send any reminder (default ₹100) */
  @Prop({ type: Number, default: 10000 })
  minimumOutstandingPaise: number;

  @Prop({ type: Number, default: 50 })
  maxRemindersPerDay: number;

  @Prop({ type: Boolean, default: true })
  defaultChannelInApp: boolean;

  @Prop({ type: Boolean, default: true })
  defaultChannelEmail: boolean;

  /** SMS default false — India DLT (TRAI 2025) requires DLT registration before sending */
  @Prop({ type: Boolean, default: false })
  defaultChannelSms: boolean;

  /** Push default false — FCM tokens not yet registered for any users */
  @Prop({ type: Boolean, default: false })
  defaultChannelPush: boolean;

  /** WhatsApp default false — AiSensy campaign template approval pending */
  @Prop({ type: Boolean, default: false })
  defaultChannelWhatsApp: boolean;

  /** Party IDs that have opted out of all reminders */
  @Prop({ type: [Types.ObjectId], default: [] })
  optOutPartyIds: Types.ObjectId[];
}

export const ReminderSettingsSchema = SchemaFactory.createForClass(ReminderSettings);
