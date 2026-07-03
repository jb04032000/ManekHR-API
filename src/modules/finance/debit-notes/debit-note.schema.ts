import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

// ─── DebitNoteLine sub-document ──────────────────────────────────────────────

@Schema({ _id: false })
export class DebitNoteLine {
  @Prop({ type: Types.ObjectId }) itemId?: Types.ObjectId;
  @Prop({ type: String }) itemName?: string;
  @Prop({ type: String }) hsnSacCode?: string;
  @Prop({ type: Number }) qty?: number;
  @Prop({ type: String }) unit?: string;
  @Prop({ type: Number }) ratePaise?: number;
  @Prop({ type: Number }) taxRate?: number;
  /** isCapitalGoods: Wave 2 service copies this from sourceBill line. NEVER accept from client payload. */
  @Prop({ type: Boolean, default: false }) isCapitalGoods?: boolean;
  @Prop({ type: Number }) taxableValuePaise?: number;
  @Prop({ type: Number, default: 0 }) cgstPaise?: number;
  @Prop({ type: Number, default: 0 }) sgstPaise?: number;
  @Prop({ type: Number, default: 0 }) igstPaise?: number;
  @Prop({ type: Number }) lineTotalPaise?: number;
}
export const DebitNoteLineSchema = SchemaFactory.createForClass(DebitNoteLine);

// ─── DebitNote document ──────────────────────────────────────────────────────

@Schema({ timestamps: true })
export class DebitNote extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, enum: ['debit_note'], default: 'debit_note' })
  voucherType: string;

  @Prop({ type: String, index: true })
  voucherNumber?: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({ type: String, required: true })
  financialYear: string;

  @Prop({ type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' })
  state: string;

  // ── Source Purchase Bill reference (MANDATORY) ────────────────────────────
  @Prop({ type: Types.ObjectId, required: true, index: true })
  sourceBillId: Types.ObjectId;

  @Prop({ type: String, required: true })
  sourceBillNumber: string;

  @Prop({ type: Date, required: true })
  sourceBillDate: Date;

  @Prop({ type: String })
  vendorBillRef?: string;

  // ── Optional GRN-Return cross-link ────────────────────────────────────────
  @Prop({ type: Types.ObjectId })
  sourceGrnReturnId?: Types.ObjectId;

  @Prop({ type: String })
  sourceGrnReturnNumber?: string;

  // ── Party (vendor) snapshot ───────────────────────────────────────────────
  @Prop({ type: Types.ObjectId, ref: 'Party', index: true })
  partyId?: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  partySnapshot?: Record<string, any>;

  @Prop({ type: String })
  placeOfSupplyStateCode?: string;

  @Prop({ type: Boolean, required: true })
  isIntraState: boolean;

  // ── DN type ───────────────────────────────────────────────────────────────
  @Prop({
    type: String,
    enum: ['goods_return', 'price_correction', 'excess_billing', 'quality_rejection', 'other'],
    required: true,
  })
  dnType: string;

  // ── Vendor acceptance tracking ────────────────────────────────────────────
  @Prop({ type: Boolean, default: false })
  vendorAccepted: boolean;

  @Prop({ type: Date })
  vendorAcceptedAt?: Date;

  // ── Line items (embedded) ─────────────────────────────────────────────────
  @Prop({ type: [DebitNoteLineSchema], default: [] })
  lineItems: DebitNoteLine[];

  // ── Totals (all in paise) ─────────────────────────────────────────────────
  @Prop({ type: Number, default: 0 }) taxableValuePaise: number;
  @Prop({ type: Number, default: 0 }) cgstPaise: number;
  @Prop({ type: Number, default: 0 }) sgstPaise: number;
  @Prop({ type: Number, default: 0 }) igstPaise: number;
  @Prop({ type: Number, default: 0 }) grandTotalPaise: number;

  // ── TDS-194Q informational note (NO auto-reversal — Edge Case 5) ──────────
  /** Informational only. Wave 2 service copies from sourceBill; no TDS auto-reversal occurs on DN posting. */
  @Prop({
    type: {
      section: { type: String },
      originalTdsPaise: { type: Number },
      reversibleTdsPaise: { type: Number },
      note: { type: String },
    },
  })
  tdsAdjustmentNote?: {
    section: string;
    originalTdsPaise: number;
    reversibleTdsPaise: number;
    note: string;
  };

  // ── Finance Act 2025 — vendor's ITC reversal status ──────────────────────
  @Prop({
    type: String,
    enum: ['pending', 'vendor_confirmed', 'not_applicable'],
    default: 'pending',
  })
  vendorItcReversalStatus: string;

  @Prop({ type: String }) narration?: string;
  @Prop({ type: [String], default: [] }) attachments: string[];
  @Prop({ type: Types.ObjectId }) postedBy?: Types.ObjectId;
  @Prop({ type: Date }) postedAt?: Date;
  @Prop({ type: Types.ObjectId }) cancelledBy?: Types.ObjectId;
  @Prop({ type: Date }) cancelledAt?: Date;
  @Prop({ type: String }) cancellationReason?: string;
  @Prop({ type: Array, default: [] }) auditLog: any[];

  // R10 quarantine: set to 'needs_attention' when a post attempt fails after the ledger write
  // rolls back (the doc stays draft), so the failed post is visible in lists for follow-up.
  // Cleared on a successful post. Mirrors SaleInvoice.postingStatus (D23).
  @Prop({ type: String, enum: ['needs_attention'], required: false })
  postingStatus?: string;

  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
}

export const DebitNoteSchema = SchemaFactory.createForClass(DebitNote);

DebitNoteSchema.index({ workspaceId: 1, firmId: 1, voucherDate: -1 });
DebitNoteSchema.index({ workspaceId: 1, firmId: 1, sourceBillId: 1 });
DebitNoteSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, state: 1 });
DebitNoteSchema.index(
  { workspaceId: 1, firmId: 1, voucherNumber: 1, financialYear: 1 },
  { unique: true, partialFilterExpression: { state: 'posted' } },
);
