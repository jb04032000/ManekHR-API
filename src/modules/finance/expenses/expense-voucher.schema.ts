import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

// ─── ExpenseVoucherLine sub-document (interface — embedded as plain sub-doc) ──

export interface ExpenseVoucherLine {
  expenseAccountId: Types.ObjectId;
  expenseAccountCode: string;
  expenseAccountName: string;
  description?: string;
  amountPaise: number;
  gstRate?: number;
  cgstPaise?: number;
  sgstPaise?: number;
  igstPaise?: number;
  /** CRITICAL: blocked credit under Section 17(5) must NOT be posted to ITC accounts */
  itcEligibility: 'full' | 'blocked' | 'nil_rated';
  lineTotalPaise: number;
  costCentre?: string;
}

// ─── ExpenseVoucher document ─────────────────────────────────────────────────

@Schema({ timestamps: true })
export class ExpenseVoucher extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, default: 'expense' })
  voucherType: string;

  @Prop({ type: String })
  voucherNumber?: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({ type: String, required: true })
  financialYear: string;

  @Prop({
    type: String,
    enum: ['draft', 'posted', 'cancelled'],
    default: 'draft',
  })
  state: string;

  @Prop({ type: Types.ObjectId })
  partyId?: Types.ObjectId;

  @Prop({ type: Object })
  partySnapshot?: Record<string, any>;

  @Prop({
    type: String,
    enum: ['cash', 'bank', 'cheque', 'upi'],
    required: true,
  })
  paymentMode: string;

  @Prop({ type: Types.ObjectId })
  cashRegisterId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  bankAccountId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  chequeId?: Types.ObjectId;

  @Prop({ type: String })
  utrReference?: string;

  @Prop({
    type: [
      {
        expenseAccountId: { type: Types.ObjectId, required: true },
        expenseAccountCode: { type: String, required: true },
        expenseAccountName: { type: String, required: true },
        description: { type: String },
        amountPaise: { type: Number, required: true },
        gstRate: { type: Number },
        cgstPaise: { type: Number },
        sgstPaise: { type: Number },
        igstPaise: { type: Number },
        itcEligibility: {
          type: String,
          enum: ['full', 'blocked', 'nil_rated'],
          required: true,
        },
        lineTotalPaise: { type: Number, required: true },
        costCentre: { type: String },
      },
    ],
    default: [],
  })
  lineItems: ExpenseVoucherLine[];

  @Prop({ type: Number, default: 0 })
  taxableValuePaise: number;

  @Prop({ type: Number, default: 0 })
  totalGstPaise: number;

  @Prop({ type: Number, default: 0 })
  grandTotalPaise: number;

  @Prop({ type: Number, default: 0 })
  totalItcEligiblePaise: number;

  @Prop({ type: Number, default: 0 })
  totalItcBlockedPaise: number;

  @Prop({
    type: {
      section: {
        type: String,
        enum: ['sec_194c', 'sec_194h', 'sec_194j', 'sec_194m'],
      },
      rate: { type: Number },
      basePaise: { type: Number },
      tdsPaise: { type: Number },
    },
  })
  tdsApplied?: {
    section: 'sec_194c' | 'sec_194h' | 'sec_194j' | 'sec_194m';
    rate: number;
    basePaise: number;
    tdsPaise: number;
  };

  @Prop({ type: Number, default: 0 })
  netPayablePaise: number;

  @Prop({ type: String, default: '' })
  narration: string;

  @Prop({ type: Boolean, default: true })
  isIntraState: boolean;

  @Prop({ type: String })
  placeOfSupplyStateCode?: string;

  @Prop({ type: Types.ObjectId, required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Array, default: [] })
  auditLog: any[];
}

export const ExpenseVoucherSchema = SchemaFactory.createForClass(ExpenseVoucher);

// Compound indexes for query performance
ExpenseVoucherSchema.index({ firmId: 1, voucherDate: -1 });
ExpenseVoucherSchema.index({ firmId: 1, state: 1 });
ExpenseVoucherSchema.index({ firmId: 1, partyId: 1 });

// Unique partial index: voucherNumber unique only for posted vouchers
ExpenseVoucherSchema.index(
  { workspaceId: 1, firmId: 1, voucherNumber: 1 },
  { unique: true, partialFilterExpression: { state: 'posted' } },
);
