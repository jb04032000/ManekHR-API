import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  VoucherState,
  VoucherType,
  LineItem,
  AdditionalCharge,
  AuditEntry,
  LinkedDoc,
} from '../voucher-base/voucher-base.interface';

/**
 * SaleInvoice schema — VoucherBase props inlined + 12 sale-invoice-specific extras.
 * Per F-02 D-05/D-06/D-10/D-11/D-12/D-22.
 */
@Schema({ timestamps: true })
export class SaleInvoice extends Document {
  // ─── VoucherBase fields (inlined per D-22) ─────────────────────────────────

  @Prop({ type: Types.ObjectId, required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  firmId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['quotation', 'sale_order', 'proforma', 'delivery_challan', 'sale_invoice'],
    required: true,
    default: 'sale_invoice',
  })
  voucherType: VoucherType;

  @Prop({ type: String, index: true })
  voucherNumber?: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({
    type: String,
    enum: ['draft', 'pending_approval', 'posted', 'cancelled', 'void'],
    default: 'draft',
    index: true,
  })
  state: VoucherState;

  @Prop({ type: Types.ObjectId, ref: 'Party', index: true })
  partyId?: Types.ObjectId;

  @Prop({ type: Object })
  partySnapshot?: Record<string, any>;

  @Prop({ type: String })
  placeOfSupplyStateCode?: string;

  // 2f multi-GSTIN: the seller GSTIN this invoice is issued under (the supplying
  // branch's registration). Defaults to the firm's primary gstin; the
  // firmStateCode for intra/inter determination derives from this.
  @Prop({ type: String })
  sellerGstin?: string;

  // 2c: tax payable by the recipient under reverse charge (Sec 9(3)/9(4)).
  // When true the supplier does not collect the tax; the IRP RegRev flag is 'Y'
  // and the print surfaces show the "tax payable under reverse charge" note.
  @Prop({ type: Boolean, default: false })
  isReverseCharge?: boolean;

  // 2d: this document is a Bill of Supply (Rule 49), not a tax invoice. Used by
  // composition dealers (Sec 10) and for wholly-exempt/nil-rated supplies. No GST
  // is charged; the print shows the "BILL OF SUPPLY" title + statutory declaration.
  @Prop({ type: Boolean, default: false })
  isBillOfSupply?: boolean;

  @Prop({
    type: {
      termsDays: { type: Number },
      dueDate: { type: Date },
    },
  })
  paymentTerms?: { termsDays: number; dueDate?: Date };

  @Prop({
    type: [
      {
        itemId: { type: Types.ObjectId, ref: 'Item' },
        itemName: { type: String },
        hsnSacCode: { type: String },
        qty: { type: Number },
        unit: { type: String },
        ratePaise: { type: Number },
        rateCentiPaise: { type: Number },
        discountPct: { type: Number, default: 0 },
        discountFlatPaise: { type: Number },
        taxRate: { type: Number, enum: [0, 5, 12, 18, 28] },
        cessRate: { type: Number, default: 0 },
        isTaxInclusive: { type: Boolean, default: false },
        taxableValuePaise: { type: Number },
        cgstPaise: { type: Number },
        sgstPaise: { type: Number },
        igstPaise: { type: Number },
        cessPaise: { type: Number },
        lineTotalPaise: { type: Number },
      },
    ],
    default: [],
  })
  lineItems: LineItem[];

  @Prop({
    type: [
      {
        label: { type: String },
        amountPaise: { type: Number },
        isTaxable: { type: Boolean, default: false },
        taxRate: { type: Number, enum: [0, 5, 12, 18, 28] },
      },
    ],
    default: [],
  })
  additionalCharges: AdditionalCharge[];

  @Prop({ type: String })
  notes?: string;

  @Prop({ type: String })
  internalNotes?: string;

  @Prop({ type: [String], default: [] })
  attachments: string[];

  @Prop({
    type: [
      {
        voucherType: {
          type: String,
          enum: ['quotation', 'sale_order', 'proforma', 'delivery_challan', 'sale_invoice'],
        },
        voucherId: { type: Types.ObjectId },
        voucherNumber: { type: String },
      },
    ],
    default: [],
  })
  linkedDocs: LinkedDoc[];

  @Prop({ type: String, index: true })
  idempotencyKey?: string;

  @Prop({ type: Date })
  draftCreatedAt?: Date;

  @Prop({ type: Date })
  draftUpdatedAt?: Date;

  @Prop({ type: Date })
  postedAt?: Date;

  @Prop({ type: Types.ObjectId })
  postedBy?: Types.ObjectId;

  @Prop({ type: Date })
  cancelledAt?: Date;

  @Prop({ type: Types.ObjectId })
  cancelledBy?: Types.ObjectId;

  @Prop({ type: String })
  cancellationReason?: string;

  @Prop({
    type: [
      {
        at: { type: Date, required: true },
        by: { type: Types.ObjectId, required: true },
        action: { type: String, required: true },
        before: { type: Object },
        after: { type: Object },
        reason: { type: String },
      },
    ],
    default: [],
  })
  auditLog: AuditEntry[];

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  // ─── Sale-invoice extras ────────────────────────────────────────────────────

  @Prop({ type: Date })
  dueDate?: Date;

  @Prop({ type: String })
  amountInWords?: string;

  @Prop({ type: Number, default: 0 })
  subtotalPaise: number;

  @Prop({ type: Number, default: 0 })
  totalDiscountPaise: number;

  @Prop({ type: Number, default: 0 })
  taxableValuePaise: number;

  @Prop({ type: Number, default: 0 })
  cgstPaise: number;

  @Prop({ type: Number, default: 0 })
  sgstPaise: number;

  @Prop({ type: Number, default: 0 })
  igstPaise: number;

  @Prop({ type: Number, default: 0 })
  cessPaise: number;

  @Prop({ type: Number, default: 0 })
  tcsPaise: number;

  @Prop({ type: Number, default: 0 })
  roundOffPaise: number;

  @Prop({ type: Number, default: 0 })
  grandTotalPaise: number;

  @Prop({ type: Number, default: 0 })
  amountPaidPaise: number;

  @Prop({ type: Number, default: 0 })
  amountDuePaise: number;

  @Prop({
    type: String,
    enum: ['unpaid', 'partial', 'paid', 'overdue'],
    default: 'unpaid',
  })
  paymentStatus: string;

  // D23 quarantine: set to 'needs_attention' when a post attempt fails after the ledger write rolls
  // back (the invoice stays draft), so the failed post is visible in lists for follow-up rather
  // than just a transient error. Cleared on a successful post.
  @Prop({ type: String, enum: ['needs_attention'], required: false })
  postingStatus?: string;

  @Prop({ type: Object })
  tcsApplied?: {
    section: string;
    rate: number;
    basePaise: number;
    amountPaise: number;
  };

  @Prop({ type: Types.ObjectId })
  brokerPartyId?: Types.ObjectId;

  @Prop({ type: Number })
  brokerCommissionPct?: number; // invoice-level override of broker's default rate

  // Cashfree payment link order reference — sparse index so webhook can find the invoice
  @Prop({ type: String })
  cashfreeOrderId?: string;

  // Late fee schedule sub-document — MUST be declared so the accrual cron query
  // { lateFeeSchedule: { $exists: true } } returns matching invoices instead of 0.
  @Prop({
    type: {
      enabled: { type: Boolean, default: false },
      ratePercent: { type: Number },
      graceDays: { type: Number, default: 0 },
      frequency: { type: String, enum: ['daily', 'weekly', 'monthly'] },
    },
    default: undefined,
  })
  lateFeeSchedule?: {
    enabled: boolean;
    ratePercent: number;
    graceDays: number;
    frequency: 'daily' | 'weekly' | 'monthly';
  };

  @Prop({ type: Object })
  shipping?: any;

  @Prop({
    type: {
      status: {
        type: String,
        enum: ['not_applicable', 'pending', 'generated', 'cancelled', 'failed'],
        default: 'not_applicable',
      },
      irn: { type: String },
      ackNo: { type: String },
      ackDate: { type: Date },
      signedQrCode: { type: String },
      signedInvoice: { type: String },
      cancelledAt: { type: Date },
      cancelReason: { type: Number },
      lastError: { type: String },
      attempts: { type: Number, default: 0 },
    },
    default: () => ({ status: 'not_applicable', attempts: 0 }),
  })
  eInvoice: {
    status: 'not_applicable' | 'pending' | 'generated' | 'cancelled' | 'failed';
    irn?: string;
    ackNo?: string;
    ackDate?: Date;
    signedQrCode?: string;
    signedInvoice?: string;
    cancelledAt?: Date;
    cancelReason?: number;
    lastError?: string;
    attempts: number;
  };

  @Prop({
    type: {
      ewbNo: { type: String },
      generatedAt: { type: Date },
      validUpto: { type: Date },
      vehicleNo: { type: String },
      status: { type: String, enum: ['active', 'cancelled', 'expired'] },
      lastError: { type: String },
    },
  })
  ewayBill?: {
    ewbNo: string;
    generatedAt: Date;
    validUpto: Date;
    vehicleNo?: string;
    status: 'active' | 'cancelled' | 'expired';
    lastError?: string;
  };

  @Prop({ type: String })
  upiQrPayload?: string;

  @Prop({ type: String })
  razorpayPaymentLinkUrl?: string;

  @Prop({ type: String, index: true, sparse: true })
  razorpayPaymentLinkId?: string;

  @Prop({ type: Types.ObjectId, ref: 'RecurringInvoiceTemplate' })
  recurringTemplateId?: Types.ObjectId;
}

export const SaleInvoiceSchema = SchemaFactory.createForClass(SaleInvoice);

// ─── Compound indexes ────────────────────────────────────────────────────────
SaleInvoiceSchema.index({ workspaceId: 1, firmId: 1, voucherDate: -1 });
SaleInvoiceSchema.index({ workspaceId: 1, firmId: 1, voucherNumber: 1 });
SaleInvoiceSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, state: 1 });
SaleInvoiceSchema.index({ workspaceId: 1, firmId: 1, paymentStatus: 1, dueDate: 1 });
// State-filtered invoice list + voucherDate sort (launch perf — Workstream F).
// SaleInvoiceService.list() always sorts { voucherDate: -1 }; when the common
// `state` filter is applied, the {partyId,state} index above has no voucherDate
// suffix, so the sort fell back to an in-memory sort of the matched set. This
// index serves the equality (ws+firm+state) AND the sort in one IXSCAN. Additive.
SaleInvoiceSchema.index({ workspaceId: 1, firmId: 1, state: 1, voucherDate: -1 });
SaleInvoiceSchema.index({ cashfreeOrderId: 1 }, { sparse: true });
// F-12: e-Invoice IRN backlog + EWB expiry management indexes (D-16)
SaleInvoiceSchema.index({ workspaceId: 1, firmId: 1, 'eInvoice.status': 1 });
SaleInvoiceSchema.index({
  workspaceId: 1,
  firmId: 1,
  'ewayBill.status': 1,
  'ewayBill.validUpto': 1,
});
