import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

// ─── CreditNoteLine sub-document ─────────────────────────────────────────────

@Schema({ _id: false })
export class CreditNoteLine {
  @Prop({ type: Types.ObjectId }) itemId?: Types.ObjectId;
  @Prop({ type: String }) itemName?: string;
  @Prop({ type: String }) hsnSacCode?: string;
  @Prop({ type: Number }) qty?: number;
  @Prop({ type: String }) unit?: string;
  @Prop({ type: Number }) ratePaise?: number;
  @Prop({ type: Number }) discountPct?: number;
  @Prop({ type: Number }) taxRate?: number;
  @Prop({ type: Number }) taxableValuePaise?: number;
  @Prop({ type: Number, default: 0 }) cgstPaise?: number;
  @Prop({ type: Number, default: 0 }) sgstPaise?: number;
  @Prop({ type: Number, default: 0 }) igstPaise?: number;
  @Prop({ type: Number }) lineTotalPaise?: number;
  /** reverseStock: true = this line item reduces stock on CN posting (selective stock reversal) */
  @Prop({ type: Boolean, default: false }) reverseStock?: boolean;
}
export const CreditNoteLineSchema = SchemaFactory.createForClass(CreditNoteLine);

// ─── CreditNote document ─────────────────────────────────────────────────────

@Schema({ timestamps: true })
export class CreditNote extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, enum: ['credit_note'], default: 'credit_note' })
  voucherType: string;

  @Prop({ type: String, index: true })
  voucherNumber?: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({ type: String, required: true })
  financialYear: string;

  @Prop({ type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' })
  state: string;

  // ── Source invoice reference (MANDATORY for GSTR-1 CDNR Table 9B) ──────────
  @Prop({ type: Types.ObjectId, required: true, index: true })
  sourceInvoiceId: Types.ObjectId;

  @Prop({ type: String, required: true })
  sourceInvoiceNumber: string;

  @Prop({ type: Date, required: true })
  sourceInvoiceDate: Date;

  @Prop({ type: Number })
  sourceInvoiceGrandTotalPaise?: number;

  // ── Party snapshot (captured at CN creation time) ─────────────────────────
  @Prop({ type: Types.ObjectId, ref: 'Party', index: true })
  partyId?: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  partySnapshot?: Record<string, any>;

  @Prop({ type: String })
  placeOfSupplyStateCode?: string;

  @Prop({ type: Boolean, required: true })
  isIntraState: boolean;

  // ── GSTR-1 classification ─────────────────────────────────────────────────
  /** cdnr = B2B registered party; cdnur = B2C unregistered party. Wave 2 derives from partySnapshot.gstin. */
  @Prop({ type: String, enum: ['cdnr', 'cdnur'], required: true })
  cdnrType: string;

  // ── CN type (governs stock reversal routing in Wave 2 service) ───────────
  @Prop({
    type: String,
    enum: ['goods_return', 'price_correction', 'post_sale_discount', 'deficiency', 'other'],
    required: true,
  })
  cnType: string;

  // ── Reason code (per TallyPrime's 7 standard reasons) ────────────────────
  @Prop({
    type: String,
    enum: [
      'sales_return',
      'post_sale_discount',
      'deficiency_in_services',
      'correction_in_invoice',
      'change_in_pos',
      'finalization_of_provisional_assessment',
      'others',
    ],
  })
  reasonCode?: string;

  // ── Line items (embedded; pre-filled from original invoice lines) ─────────
  @Prop({ type: [CreditNoteLineSchema], default: [] })
  lineItems: CreditNoteLine[];

  // ── Totals (all in paise) ─────────────────────────────────────────────────
  @Prop({ type: Number, default: 0 }) taxableValuePaise: number;
  @Prop({ type: Number, default: 0 }) cgstPaise: number;
  @Prop({ type: Number, default: 0 }) sgstPaise: number;
  @Prop({ type: Number, default: 0 }) igstPaise: number;
  @Prop({ type: Number, default: 0 }) grandTotalPaise: number;

  // ── Finance Act 2025 — recipient ITC reversal compliance ──────────────────
  /** Wave 2 blocks post() when status is 'pending' AND grandTotalPaise > 50000000 (₹5L in paise). */
  @Prop({
    type: String,
    enum: ['pending', 'self_declared', 'ca_certified', 'not_applicable'],
    default: 'pending',
  })
  recipientItcReversalStatus: string;

  /** Upload URL (R2/local). Wave 2 must validate URL origin before persisting. */
  @Prop({ type: String })
  recipientItcReversalDocUrl?: string;

  // ── Refund tracking — when CN exceeds outstanding (Edge Case 1) ──────────
  @Prop({ type: Number, default: 0 })
  refundAmountPaise: number;

  // Commercial / financial credit note (kasar-vatav): NO GST adjustment when true - the
  // full value posts to 5026 Kasar-Vatav Allowed instead of reversing output tax (D11).
  @Prop({ type: Boolean, default: false })
  isCommercial: boolean;

  @Prop({ type: String }) narration?: string;
  @Prop({ type: String }) notes?: string;
  @Prop({ type: [String], default: [] }) attachments: string[];

  @Prop({ type: Types.ObjectId }) postedBy?: Types.ObjectId;
  @Prop({ type: Date }) postedAt?: Date;
  @Prop({ type: Types.ObjectId }) cancelledBy?: Types.ObjectId;
  @Prop({ type: Date }) cancelledAt?: Date;
  @Prop({ type: String }) cancellationReason?: string;
  @Prop({ type: Array, default: [] }) auditLog: any[];
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;

  // e-Invoice (IRN) for this credit note. Credit notes are e-invoice documents (CRN) for
  // e-invoice-eligible firms. Shape mirrors SaleInvoice.eInvoice so EInvoiceService can
  // persist on either voucher. Populated by EInvoiceService.generateIrnForCreditNote.
  @Prop({
    type: {
      status: {
        type: String,
        enum: ['not_applicable', 'pending', 'generated', 'failed', 'cancelled'],
      },
      irn: { type: String },
      ackNo: { type: String },
      ackDate: { type: Date },
      signedQrCode: { type: String },
      signedInvoice: { type: String },
      lastError: { type: String },
      attempts: { type: Number, default: 0 },
      cancelledAt: { type: Date },
      cancelReason: { type: Number },
    },
  })
  eInvoice?: {
    status?: string;
    irn?: string;
    ackNo?: string;
    ackDate?: Date;
    signedQrCode?: string;
    signedInvoice?: string;
    lastError?: string;
    attempts?: number;
    cancelledAt?: Date;
    cancelReason?: number;
  };

  // R10 quarantine: set to 'needs_attention' when a post attempt fails after the ledger write
  // rolls back (the doc stays draft), so the failed post is visible in lists for follow-up.
  // Cleared on a successful post. Mirrors SaleInvoice.postingStatus (D23).
  @Prop({ type: String, enum: ['needs_attention'], required: false })
  postingStatus?: string;
}

export const CreditNoteSchema = SchemaFactory.createForClass(CreditNote);

CreditNoteSchema.index({ workspaceId: 1, firmId: 1, voucherDate: -1 });
CreditNoteSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, state: 1 });
CreditNoteSchema.index({ workspaceId: 1, firmId: 1, sourceInvoiceId: 1 });
CreditNoteSchema.index(
  { workspaceId: 1, firmId: 1, voucherNumber: 1, financialYear: 1 },
  { unique: true, partialFilterExpression: { state: 'posted' } },
);
