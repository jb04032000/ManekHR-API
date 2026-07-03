import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Per-month amortisation row for a loan account.
 *
 * CRITICAL (Pitfall 5): This document's `_id` is used as LedgerEntry.sourceVoucherId
 * for EMI postings — NOT the loanAccountId. This avoids the unique-index conflict on
 * (workspaceId, firmId, sourceVoucherId, sourceVoucherType) for multi-month EMIs.
 *
 * T-F06W1-07: workspaceId + firmId required + indexed for workspace isolation.
 */
@Schema({ timestamps: true })
export class LoanScheduleEntry extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  loanAccountId: Types.ObjectId;

  /** YYYY-MM — the month this amortisation row covers */
  @Prop({ type: String, required: true })
  month: string;

  @Prop({ type: Number, required: true })
  openingPrincipalPaise: number;

  @Prop({ type: Number, required: true })
  emiAmountPaise: number;

  @Prop({ type: Number, required: true })
  principalComponentPaise: number;

  @Prop({ type: Number, required: true })
  interestComponentPaise: number;

  @Prop({ type: Number, required: true })
  closingPrincipalPaise: number;

  @Prop({
    type: String,
    enum: ['pending', 'paid', 'prepaid', 'overdue'],
    default: 'pending',
  })
  status: string;

  @Prop({ type: Date })
  paidOn?: Date;

  /** Set after EMI cron posts the LedgerEntry */
  @Prop({ type: Types.ObjectId })
  ledgerEntryId?: Types.ObjectId;
}

export const LoanScheduleEntrySchema = SchemaFactory.createForClass(LoanScheduleEntry);

/** One schedule row per loan per month — unique compound index */
LoanScheduleEntrySchema.index({ loanAccountId: 1, month: 1 }, { unique: true });
LoanScheduleEntrySchema.index({ firmId: 1, status: 1 });
