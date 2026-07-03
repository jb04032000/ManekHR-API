import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ _id: false })
export class PurchaseBillLineItem {
  @Prop({ type: Types.ObjectId }) itemId?: Types.ObjectId;
  @Prop({ type: String }) itemName?: string;
  @Prop({ type: String }) hsnSacCode?: string;
  @Prop({ type: Number }) qty?: number;
  @Prop({ type: String }) unit?: string;
  @Prop({ type: Number }) ratePaise?: number;
  @Prop({ type: Number, default: 0 }) discountPct?: number;
  @Prop({ type: Number }) taxRate?: number;
  @Prop({ type: Number }) taxableValuePaise?: number;
  @Prop({ type: Number, default: 0 }) cgstPaise?: number;
  @Prop({ type: Number, default: 0 }) sgstPaise?: number;
  @Prop({ type: Number, default: 0 }) igstPaise?: number;
  @Prop({ type: Number }) lineTotalPaise?: number;
  @Prop({ type: Boolean, default: false })
  isCapitalGoods?: boolean;
}
export const PurchaseBillLineItemSchema = SchemaFactory.createForClass(PurchaseBillLineItem);
// isCapitalGoods: true triggers CapitalGoodsItcSchedule creation at PurchaseBill post time

@Schema({ _id: false })
export class Tds194QDetail {
  @Prop({ type: String, default: '194Q' }) section: string;
  @Prop({ type: Number, required: true }) rate: number; // e.g., 0.001
  @Prop({ type: Number, required: true }) basePaise: number; // amount above ₹50L threshold
  @Prop({ type: Number, required: true }) tdsPaise: number;
  @Prop({ type: Number, required: true }) cumulativeBeforePaise: number;
}
export const Tds194QDetailSchema = SchemaFactory.createForClass(Tds194QDetail);
// tds194Q sub-doc: populated at bill post when firm.aato > ₹10Cr and cumulative vendor spend > ₹50L (Sec 194Q)

interface PBAuditEntry {
  at: Date;
  by: Types.ObjectId;
  action: string;
  reason?: string;
}

@Schema({ timestamps: true })
export class PurchaseBill extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: String, enum: ['purchase_bill'], default: 'purchase_bill' }) voucherType: string;
  @Prop({ type: String, index: true }) voucherNumber?: string;
  @Prop({ type: Date, required: true }) voucherDate: Date;
  @Prop({ type: String, required: true }) financialYear: string;
  @Prop({ type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' }) state: string;

  // Vendor's own bill reference (required for GSTR-2A reconciliation)
  @Prop({ type: String }) vendorBillNumber?: string;
  @Prop({ type: Date }) vendorBillDate?: Date;

  @Prop({ type: Types.ObjectId, ref: 'Party' }) partyId?: Types.ObjectId;
  @Prop({ type: Object, default: {} }) partySnapshot?: Record<string, any>;
  @Prop({ type: String }) placeOfSupplyStateCode?: string;

  // 2c reverse charge: tax on this purchase is payable by the recipient (this firm)
  // under Sec 9(3)/9(4). When the supplier is unregistered, posting generates a
  // self-invoice under Sec 31(3)(f) / Rule 47A.
  @Prop({ type: Boolean, default: false }) isReverseCharge?: boolean;

  // RCM self-invoice issued by the recipient (Rule 47A). dueDate = receipt of
  // supply + 30 days (Rule 47A, effective 1-Nov-2024). Generated at post.
  @Prop({
    type: { number: { type: String }, date: { type: Date }, dueDate: { type: Date } },
    _id: false,
  })
  rcmSelfInvoice?: { number: string; date: Date; dueDate: Date };

  @Prop({ type: [PurchaseBillLineItemSchema], default: [] }) lineItems: PurchaseBillLineItem[];

  // Source links (PO/GRN)
  @Prop({ type: Types.ObjectId }) sourcePoId?: Types.ObjectId;
  @Prop({ type: String }) sourcePoNumber?: string;
  @Prop({ type: Types.ObjectId }) sourceGrnId?: Types.ObjectId;
  @Prop({ type: String }) sourceGrnNumber?: string;

  // TDS-194Q applied at bill post (only — never 194C/H/J at this stage)
  @Prop({ type: Tds194QDetailSchema })
  tds194Q?: Tds194QDetail;

  // Computed totals (paise)
  @Prop({ type: Number, default: 0 }) taxableValuePaise: number;
  @Prop({ type: Number, default: 0 }) cgstPaise: number;
  @Prop({ type: Number, default: 0 }) sgstPaise: number;
  @Prop({ type: Number, default: 0 }) igstPaise: number;
  @Prop({ type: Number, default: 0 }) grandTotalPaise: number;
  @Prop({ type: Number, default: 0 }) netPayableToCreditorsAfterTdsPaise: number;
  @Prop({ type: Number, default: 0 }) amountPaidPaise: number;
  @Prop({ type: Number, default: 0 }) amountDuePaise: number;
  @Prop({ type: String, enum: ['unpaid', 'partial', 'paid', 'overdue'], default: 'unpaid' })
  paymentStatus: string;

  // OCR fields
  @Prop({ type: String }) ocrSourceFileUrl?: string;
  @Prop({ type: Number }) ocrConfidence?: number;
  @Prop({ type: String, enum: ['manual', 'ocr_prefilled', 'ocr_auto_filled'], default: 'manual' })
  ocrStatus?: string;

  // MSME 43B(h) — clock starts at PB post
  @Prop({ type: Date }) msmePaymentDeadline?: Date;
  @Prop({ type: Boolean, default: false }) msmeApplicable: boolean;

  // R10: D23 quarantine: set to 'needs_attention' when a post attempt fails after the ledger write rolls
  // back (the bill stays draft), so the failed post is visible in lists for follow-up rather
  // than just a transient error. Cleared on a successful post. Mirrors SaleInvoice.postingStatus.
  @Prop({ type: String, enum: ['needs_attention'], required: false })
  postingStatus?: string;

  @Prop({ type: String }) idempotencyKey?: string;
  @Prop({ type: Types.ObjectId }) postedBy?: Types.ObjectId;
  @Prop({ type: Date }) postedAt?: Date;
  @Prop({ type: Array, default: [] }) auditLog: PBAuditEntry[];
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
}

export const PurchaseBillSchema = SchemaFactory.createForClass(PurchaseBill);
PurchaseBillSchema.index({ workspaceId: 1, firmId: 1, voucherDate: -1 });
PurchaseBillSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, state: 1 });
PurchaseBillSchema.index({ workspaceId: 1, firmId: 1, state: 1, voucherDate: -1 });
PurchaseBillSchema.index({ workspaceId: 1, firmId: 1, paymentStatus: 1 });
// paymentStatus-filtered bill list + voucherDate sort (launch perf — Workstream F).
// PurchaseBillService.list() always sorts { voucherDate: -1 }; the paymentStatus
// index above has no voucherDate suffix, so a paymentStatus filter (incl. the
// common $in: ['unpaid','partial','overdue']) sorted in memory. Adding voucherDate
// lets the planner satisfy filter + sort from the index. Additive.
PurchaseBillSchema.index({ workspaceId: 1, firmId: 1, paymentStatus: 1, voucherDate: -1 });
PurchaseBillSchema.index(
  { workspaceId: 1, firmId: 1, partyId: 1, vendorBillNumber: 1 },
  { sparse: true },
);
