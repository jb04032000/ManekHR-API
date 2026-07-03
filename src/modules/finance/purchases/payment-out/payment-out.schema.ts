import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ _id: false })
export class PaymentOutBillAllocation {
  @Prop({ type: Types.ObjectId, required: true }) billId: Types.ObjectId;
  @Prop({ type: String, required: true }) billNumber: string;
  @Prop({ type: Number, required: true }) billDuePaise: number;
  @Prop({ type: Number, required: true }) allocatedPaise: number;
  @Prop({ type: Number, required: true }) runningDuePaise: number;
}
export const PaymentOutBillAllocationSchema =
  SchemaFactory.createForClass(PaymentOutBillAllocation);
// billAllocations[]: each entry links a PaymentOut to a specific PurchaseBill and records how much was applied

@Schema({ _id: false })
export class TdsAppliedDetail {
  @Prop({ type: String, enum: ['sec_194c', 'sec_194h', 'sec_194j'], required: true })
  section: string;
  @Prop({ type: Number, required: true }) rate: number; // e.g., 0.01 for 1%
  @Prop({ type: Number, required: true }) basePaise: number; // amount on which TDS computed
  @Prop({ type: Number, required: true }) tdsPaise: number;
  @Prop({ type: Number, required: true }) cumulativeBeforePaise: number;
}
export const TdsAppliedDetailSchema = SchemaFactory.createForClass(TdsAppliedDetail);
// tdsApplied sub-doc: populated when 194C/194H/194J applies at PaymentOut post time

interface POutAuditEntry {
  at: Date;
  by: Types.ObjectId;
  action: string;
  reason?: string;
}

@Schema({ timestamps: true })
export class PaymentOut extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: String, enum: ['payment_out'], default: 'payment_out' }) voucherType: string;
  @Prop({ type: String }) voucherNumber?: string;
  @Prop({ type: String, required: true }) financialYear: string;
  @Prop({ type: Date, required: true }) paymentDate: Date;

  @Prop({ type: Types.ObjectId, required: true }) partyId: Types.ObjectId;
  @Prop({ type: Object, default: {} }) partySnapshot: Record<string, any>;

  @Prop({
    type: String,
    enum: ['cash', 'bank', 'upi', 'cheque', 'neft', 'rtgs', 'imps'],
    required: true,
  })
  paymentMode: string;
  @Prop({ type: Types.ObjectId }) bankAccountId?: Types.ObjectId;
  @Prop({ type: String }) referenceNo?: string;
  @Prop({ type: Date }) referenceDate?: Date;

  @Prop({ type: Number, required: true, min: 1 }) totalAmountPaise: number; // gross amount before TDS
  @Prop({ type: [PaymentOutBillAllocationSchema], default: [] })
  billAllocations: PaymentOutBillAllocation[];
  @Prop({ type: Number, default: 0 }) unappliedPaise: number; // Cr Advance to Suppliers (1005)

  // TDS deducted at this PaymentOut (sec_194c | sec_194h | sec_194j)
  @Prop({ type: TdsAppliedDetailSchema })
  tdsApplied?: TdsAppliedDetail;

  // 2c reverse charge: payment voucher (Sec 31(3)(g) / Rule 52) issued by the
  // recipient when paying a supplier on a reverse-charge purchase. Generated at
  // post when any allocated bill is flagged isReverseCharge.
  @Prop({
    type: { number: { type: String }, date: { type: Date } },
    _id: false,
  })
  rcmPaymentVoucher?: { number: string; date: Date };

  // Computed: Dr Sundry Creditors (full bill allocations net of any 194Q already at bill time)
  @Prop({ type: Number, default: 0 }) allocatedToCreditorsAfterTds94qPaise: number;
  // Computed: Cr Cash/Bank — actual money paid to vendor (totalAmountPaise - tdsPaise)
  @Prop({ type: Number, default: 0 }) netPaidPaise: number;

  @Prop({ type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' }) state: string;
  @Prop({ type: String }) idempotencyKey?: string;
  @Prop({ type: Date }) postedAt?: Date;
  @Prop({ type: Types.ObjectId }) postedBy?: Types.ObjectId;
  @Prop({ type: Array, default: [] }) auditLog: POutAuditEntry[];
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
}

export const PaymentOutSchema = SchemaFactory.createForClass(PaymentOut);
PaymentOutSchema.index({ workspaceId: 1, firmId: 1, paymentDate: -1 });
PaymentOutSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, state: 1 });
PaymentOutSchema.index({ workspaceId: 1, firmId: 1, state: 1, paymentDate: -1 });
