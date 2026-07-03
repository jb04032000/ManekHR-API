import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Idempotency guard for the monthly EMI cron.
 * Mirrors the DepreciationRun / CapitalGoodsItcCron pattern from F-04/F-05.
 *
 * Before posting EMI for a (loanAccountId, runMonth), cron upserts a LoanEmiRun
 * document. If status = 'completed', skip. If status = 'running', another process
 * is already handling it. Only proceed when document doesn't exist.
 */
@Schema({ timestamps: true })
export class LoanEmiRun extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  loanAccountId: Types.ObjectId;

  /** YYYY-MM — the month this EMI run covers */
  @Prop({ type: String, required: true })
  runMonth: string;

  @Prop({
    type: String,
    enum: ['running', 'completed', 'failed'],
    default: 'running',
  })
  status: string;

  /** Set after successful LedgerEntry creation */
  @Prop({ type: Types.ObjectId })
  ledgerEntryId?: Types.ObjectId;

  @Prop({ type: Date })
  runAt?: Date;
}

export const LoanEmiRunSchema = SchemaFactory.createForClass(LoanEmiRun);

/** Unique per loan per month — prevents duplicate EMI cron executions */
LoanEmiRunSchema.index(
  { firmId: 1, loanAccountId: 1, runMonth: 1 },
  { unique: true },
);
