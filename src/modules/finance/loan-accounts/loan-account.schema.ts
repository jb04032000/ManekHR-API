import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class LoanAccount extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  /** Auto-generated: LN/2024-25/0001 */
  @Prop({ required: true })
  loanCode: string;

  /** e.g., "HDFC Term Loan - Machinery" */
  @Prop({ required: true })
  name: string;

  @Prop({ type: Types.ObjectId })
  lenderPartyId?: Types.ObjectId;

  @Prop({ required: true })
  lenderName: string;

  @Prop({
    type: String,
    enum: ['term_loan', 'overdraft', 'cash_credit'],
    required: true,
  })
  loanType: string;

  @Prop({ type: Number, required: true })
  sanctionedAmountPaise: number;

  @Prop({ type: Number, required: true })
  disbursedAmountPaise: number;

  @Prop({ type: Date, required: true })
  disbursementDate: Date;

  /** e.g., 11.5 (percentage per annum) */
  @Prop({ type: Number, required: true })
  interestRateAnnual: number;

  /** 0 for OD/CC revolving facilities */
  @Prop({ type: Number, default: 0 })
  tenureMonths: number;

  @Prop({ type: Date, required: true })
  repaymentStartDate: Date;

  /** Computed from reducing-balance formula: EMI = P × r × (1+r)^n / ((1+r)^n − 1) */
  @Prop({ type: Number, default: 0 })
  emiAmountPaise: number;

  @Prop({ type: Number })
  processingFeePaise?: number;

  /** CoA liability account: 2017 Loan from Bank or sub-account */
  @Prop({ type: Types.ObjectId, required: true })
  coaLiabilityAccountId: Types.ObjectId;

  @Prop({ required: true })
  coaLiabilityAccountCode: string;

  /** Decremented on each EMI principal component posting */
  @Prop({ type: Number, required: true })
  principalOutstandingPaise: number;

  @Prop({ type: Number, default: 0 })
  totalInterestPaidPaise: number;

  /**
   * YYYY-MM cursor — same pattern as CapitalGoodsItcSchedule.nextAmortisationMonth.
   * Cron filters: { status: 'active', nextEmiMonth: { $lte: thisMonth } }
   */
  @Prop({ type: String })
  nextEmiMonth?: string;

  @Prop({ type: String })
  lastEmiMonth?: string;

  @Prop({
    type: String,
    enum: ['active', 'closed', 'npa'],
    default: 'active',
  })
  status: string;

  @Prop({ type: Date })
  closureDate?: Date;

  @Prop({
    type: String,
    enum: ['foreclosure', 'full_repayment'],
  })
  closureType?: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Array, default: [] })
  auditLog: any[];
}

export const LoanAccountSchema = SchemaFactory.createForClass(LoanAccount);

LoanAccountSchema.index({ firmId: 1, status: 1, nextEmiMonth: 1 });
LoanAccountSchema.index({ workspaceId: 1, firmId: 1, loanCode: 1 }, { unique: true });
