import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class RecurringInvoiceTemplate extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, required: true })
  templateName: string;

  @Prop({ type: Types.ObjectId, ref: 'Party', required: true })
  partyId: Types.ObjectId;

  @Prop({ type: [Object], default: [] })
  lineItems: any[];

  @Prop({ type: [Object], default: [] })
  additionalCharges: any[];

  @Prop({ type: String })
  placeOfSupplyStateCode?: string;

  @Prop({
    type: {
      termsDays: { type: Number },
      label: { type: String },
    },
  })
  paymentTerms?: { termsDays?: number; label?: string };

  @Prop({ type: String })
  notes?: string;

  @Prop({
    type: {
      mode: {
        type: String,
        enum: ['monthly', 'quarterly', 'yearly', 'every_n_days'],
        required: true,
      },
      dayOfMonth: { type: Number },
      everyNDays: { type: Number },
      startDate: { type: Date, required: true },
      endDate: { type: Date },
    },
    required: true,
  })
  schedule: {
    mode: 'monthly' | 'quarterly' | 'yearly' | 'every_n_days';
    dayOfMonth?: number;
    everyNDays?: number;
    startDate: Date;
    endDate?: Date;
  };

  @Prop({ type: Boolean, default: true })
  amountAuto: boolean;

  @Prop({ type: Boolean, default: false })
  autoPostOnGenerate: boolean;

  @Prop({
    type: {
      email: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: false },
      sms: { type: Boolean, default: false },
    },
    default: () => ({ email: true, whatsapp: false, sms: false }),
  })
  notifyOnGenerate: { email: boolean; whatsapp: boolean; sms: boolean };

  @Prop({ type: Boolean, default: true, index: true })
  isActive: boolean;

  @Prop({ type: Date, index: true })
  nextRunAt: Date;

  @Prop({ type: Date })
  lastRunAt?: Date;

  @Prop({ type: Number, default: 0 })
  runCount: number;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const RecurringInvoiceTemplateSchema = SchemaFactory.createForClass(RecurringInvoiceTemplate);

// Compound index for cron query: find due templates efficiently
RecurringInvoiceTemplateSchema.index({ nextRunAt: 1, isActive: 1, isDeleted: 1 });
