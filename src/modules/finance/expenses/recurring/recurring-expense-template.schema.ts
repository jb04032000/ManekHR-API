import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * 4a: Recurring expense template. Generates expense vouchers on a schedule
 * (e.g. monthly rent / electricity / maintenance) via the daily cron. Mirrors
 * the RecurringInvoiceTemplate engine on the sales side.
 */
export interface RecurringExpenseLine {
  expenseAccountId: Types.ObjectId;
  description?: string;
  amountPaise: number;
  gstRate?: number;
  itcEligibility: 'full' | 'blocked' | 'nil_rated';
  costCentre?: string;
}

@Schema({ timestamps: true })
export class RecurringExpenseTemplate extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, required: true })
  templateName: string;

  @Prop({ type: Types.ObjectId, ref: 'Party' })
  partyId?: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['cash', 'bank', 'cheque', 'upi'],
    required: true,
  })
  paymentMode: string;

  @Prop({ type: Types.ObjectId })
  bankAccountId?: Types.ObjectId;

  @Prop({
    type: [
      {
        expenseAccountId: { type: Types.ObjectId, required: true },
        description: { type: String },
        amountPaise: { type: Number, required: true },
        gstRate: { type: Number },
        itcEligibility: {
          type: String,
          enum: ['full', 'blocked', 'nil_rated'],
          default: 'full',
        },
        costCentre: { type: String },
      },
    ],
    default: [],
  })
  lineItems: RecurringExpenseLine[];

  @Prop({ type: Boolean, default: true })
  isIntraState: boolean;

  @Prop({ type: String })
  placeOfSupplyStateCode?: string;

  @Prop({ type: String, default: '' })
  narration: string;

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

  @Prop({ type: Boolean, default: false })
  autoPostOnGenerate: boolean;

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

export const RecurringExpenseTemplateSchema =
  SchemaFactory.createForClass(RecurringExpenseTemplate);

// Cron query: find due templates efficiently.
RecurringExpenseTemplateSchema.index({ nextRunAt: 1, isActive: 1, isDeleted: 1 });
