import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

// PaymentAllocation sub-document
@Schema({ _id: false })
export class PaymentAllocation {
  @Prop({ type: Types.ObjectId, required: true }) invoiceId: Types.ObjectId;
  @Prop({ type: String, required: true }) invoiceNumber: string;
  @Prop({ type: Number, required: true }) invoiceDuePaise: number;       // snapshot at allocation time
  @Prop({ type: Number, required: true }) allocatedPaise: number;
  @Prop({ type: Number, required: true }) runningDuePaise: number;       // invoice.amountDuePaise AFTER this alloc
}
export const PaymentAllocationSchema = SchemaFactory.createForClass(PaymentAllocation);

// AuditEntry sub-document (replicate pattern from voucher-base)
interface PaymentAuditEntry {
  at: Date;
  by: Types.ObjectId;
  action: string;
  reason?: string;
}

@Schema({ timestamps: true })
export class PaymentReceipt extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: String }) voucherNumber?: string;
  @Prop({ type: String, required: true }) financialYear: string;
  @Prop({ type: Date, required: true }) receiptDate: Date;
  @Prop({ type: Types.ObjectId, required: true }) partyId: Types.ObjectId;
  @Prop({ type: Object, default: {} }) partySnapshot: Record<string, any>;
  @Prop({ type: String, enum: ['cash', 'bank', 'upi', 'cheque', 'neft', 'rtgs', 'imps', 'razorpay', 'cashfree'], required: true }) paymentMode: string;
  @Prop({ type: Types.ObjectId }) bankAccountId?: Types.ObjectId;
  @Prop({ type: String }) referenceNo?: string;
  @Prop({ type: Date }) referenceDate?: Date;
  @Prop({ type: Number, required: true, min: 1 }) totalAmountPaise: number;
  @Prop({ type: [PaymentAllocationSchema], default: [] }) allocations: PaymentAllocation[];
  @Prop({ type: Number, default: 0 }) unappliedPaise: number;
  @Prop({ type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' }) state: string;
  @Prop({ type: Types.ObjectId }) brokerPartyId?: Types.ObjectId;
  @Prop({ type: Number }) brokerCommissionPaise?: number;
  @Prop({ type: Boolean, default: false }) brokerCommissionPosted: boolean;
  @Prop({ type: String }) onlinePaymentId?: string;
  @Prop({ type: String, enum: ['razorpay', 'cashfree'] }) onlinePaymentGateway?: string;
  @Prop({ type: Boolean, default: false }) autoReconciled: boolean;
  @Prop({ type: String }) idempotencyKey?: string;
  @Prop({ type: Date }) postedAt?: Date;
  @Prop({ type: Types.ObjectId }) postedBy?: Types.ObjectId;
  @Prop({ type: Array, default: [] }) auditLog: PaymentAuditEntry[];
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
}

export const PaymentReceiptSchema = SchemaFactory.createForClass(PaymentReceipt);

// Compound indexes
PaymentReceiptSchema.index({ workspaceId: 1, firmId: 1, receiptDate: -1 });
PaymentReceiptSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, state: 1 });
PaymentReceiptSchema.index({ workspaceId: 1, firmId: 1, state: 1, receiptDate: -1 });
PaymentReceiptSchema.index({ onlinePaymentId: 1 }, { sparse: true });
