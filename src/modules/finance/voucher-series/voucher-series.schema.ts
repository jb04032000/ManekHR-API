import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class VoucherSeries extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({
    type: String,
    enum: [
      'sale_invoice', 'sale_order', 'proforma', 'delivery_challan',
      'credit_note', 'purchase_bill', 'purchase_order', 'grn',
      'debit_note', 'payment_in', 'payment_out', 'expense',
      'journal', 'manufacturing_voucher', 'job_work_in', 'job_work_out', 'job_work_invoice',
      'fixed_asset_addition',
      'contra',
      'loan_account',
      'grn_return',
      'stock_transfer',
      'wastage_entry',
      'sample_voucher',
    ],
    required: true,
  })
  voucherType: string;

  @Prop({ required: true })
  prefix: string;

  @Prop({ type: Number, default: 1 })
  startNumber: number;

  @Prop({ type: Number, default: 4 })
  padDigits: number;

  @Prop({ required: true })
  financialYear: string;

  @Prop({ type: Number, default: 0 })
  lastUsed: number;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const VoucherSeriesSchema = SchemaFactory.createForClass(VoucherSeries);
VoucherSeriesSchema.index(
  { firmId: 1, voucherType: 1, financialYear: 1 },
  { unique: true },
);
