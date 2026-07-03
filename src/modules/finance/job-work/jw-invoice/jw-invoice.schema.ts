import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type JobWorkInvoiceDocument = HydratedDocument<JobWorkInvoice>;

// ─── JwInvoiceLine sub-document ───────────────────────────────────────────────

@Schema({ _id: false })
export class JwInvoiceLine {
  @Prop({ type: Number, required: true })
  lineNo: number;

  @Prop({ type: String, required: true, trim: true })
  description: string;

  /** HSN 9988 — Textile job-work (embroidery/dyeing/printing on textile) */
  @Prop({ type: String, required: true, default: '9988' })
  hsnCode: string;

  /**
   * Textile job-work activity, drives the GST rate (see job-work-rate.ts).
   * Defaults to general_textile (5%) so existing rows keep their behaviour.
   */
  @Prop({
    type: String,
    // R5: process split. dyeing_printing kept as a legacy value for old documents;
    // new rows pick printing/embroidery so income posts to 4022/4023 (see job-work-rate.ts).
    enum: ['general_textile', 'embroidery', 'dyeing_printing', 'printing', 'other'],
    default: 'general_textile',
  })
  jobWorkType: string;

  @Prop({ type: Number, required: true, min: 0 })
  qty: number;

  @Prop({ type: String, required: true })
  unit: string;

  /** Rate per unit in paise; starts at 0 (user must fill before posting) */
  @Prop({ type: Number, required: true, min: 0, default: 0 })
  ratePaise: number;

  /** Optional high-precision per-unit rate, 1/10000-rupee units (4 dp). Authoritative when present; ratePaise is its rounded 2-dp mirror. */
  @Prop({ type: Number })
  rateCentiPaise?: number;

  /**
   * Derived from jobWorkType via resolveJobWorkRate() in the service.
   * 5 for general textile job-work, 18 for dyeing/printing and residuary.
   */
  @Prop({ type: Number, required: true, default: 5 })
  taxRate: number;

  /** qty × ratePaise; computed in service */
  @Prop({ type: Number, required: true, min: 0, default: 0 })
  amountPaise: number;

  @Prop({ type: Types.ObjectId, ref: 'JobWorkLot' })
  jobWorkLotId?: Types.ObjectId;

  /** Line-level karigar if different from invoice header */
  @Prop({ type: [Types.ObjectId], ref: 'TeamMember', default: [] })
  karigarIds: Types.ObjectId[];
}

export const JwInvoiceLineSchema = SchemaFactory.createForClass(JwInvoiceLine);

// ─── JobWorkInvoice root document ─────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'jobworkinvoices' })
export class JobWorkInvoice {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, default: 'job_work_invoice' })
  voucherType: string;

  /**
   * From VoucherSeries 'job_work_invoice'. Default '' on draft; assigned on post.
   * Partial unique index prevents collision across multiple drafts with empty voucherNumber.
   */
  @Prop({ type: String, trim: true, default: '' })
  voucherNumber: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({
    type: String,
    enum: ['draft', 'posted', 'cancelled'],
    default: 'draft',
    required: true,
  })
  status: 'draft' | 'posted' | 'cancelled';

  @Prop({ type: Types.ObjectId, ref: 'Party', required: true })
  partyId: Types.ObjectId;

  @Prop({ type: Object })
  partySnapshot?: Record<string, any>;

  /** Linked JWO challan (mandatory) */
  @Prop({ type: Types.ObjectId, ref: 'JobWorkOutwardChallan', required: true })
  jwOutwardChallanId: Types.ObjectId;

  /** Denormalized for display on invoice */
  @Prop({ type: String, trim: true })
  jwOutwardChallanNo?: string;

  @Prop({ type: [JwInvoiceLineSchema], default: [] })
  lines: JwInvoiceLine[];

  // ── Tax computation ────────────────────────────────────────────────────────

  /** Determines IGST (interstate) vs CGST+SGST (intrastate) */
  @Prop({ type: String, required: true })
  placeOfSupplyStateCode: string;

  /** Default false; rarely applicable for job-work */
  @Prop({ type: Boolean, default: false })
  reverseCharge: boolean;

  /** Sum of line amounts in paise */
  @Prop({ type: Number, required: true, default: 0 })
  subTotalPaise: number;

  /** Intrastate only */
  @Prop({ type: Number })
  cgstPaise?: number;

  /** Intrastate only */
  @Prop({ type: Number })
  sgstPaise?: number;

  /** Interstate only */
  @Prop({ type: Number })
  igstPaise?: number;

  /** 0 for HSN 9988 (no cess on textile job-work) */
  @Prop({ type: Number })
  cessAmountPaise?: number;

  @Prop({ type: Number })
  roundOffPaise?: number;

  @Prop({ type: Number, required: true, default: 0 })
  totalPaise: number;

  // ── Karigar attribution (propagated from JWO) ─────────────────────────────

  @Prop({ type: [Types.ObjectId], ref: 'TeamMember', required: true, default: [] })
  karigarIds: Types.ObjectId[];

  @Prop({ type: [Types.ObjectId], default: [] })
  machineIds: Types.ObjectId[];

  // ── Ledger linkage ────────────────────────────────────────────────────────

  /**
   * Array because cancel reversal adds a second entry.
   * [0] = post entry, [1] = reversal entry (if cancelled).
   */
  @Prop({ type: [Types.ObjectId], ref: 'LedgerEntry', default: [] })
  ledgerEntryIds: Types.ObjectId[];

  // ── Payment linkage ───────────────────────────────────────────────────────

  @Prop({
    type: String,
    enum: ['unpaid', 'partial', 'paid'],
    default: 'unpaid',
    required: true,
  })
  paymentStatus: 'unpaid' | 'partial' | 'paid';

  /** Updated by PaymentReceipt module */
  @Prop({ type: Number, default: 0 })
  paidAmountPaise: number;

  @Prop({ type: Date })
  dueDate?: Date;

  /**
   * Required for LedgerEntry.financialYear index.
   * Format: "2025-26"
   */
  @Prop({ type: String, required: true })
  financialYear: string;

  @Prop({ type: String })
  narration?: string;

  // R10 quarantine: set to 'needs_attention' when a post attempt fails after the ledger write
  // rolls back (the doc stays draft), so the failed post is visible in lists for follow-up.
  // Cleared on a successful post. Mirrors SaleInvoice.postingStatus (D23).
  @Prop({ type: String, enum: ['needs_attention'], required: false })
  postingStatus?: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;
}

export const JobWorkInvoiceSchema = SchemaFactory.createForClass(JobWorkInvoice);

// D-04 indexes
JobWorkInvoiceSchema.index({ workspaceId: 1, firmId: 1, status: 1, voucherDate: -1 });
JobWorkInvoiceSchema.index({ workspaceId: 1, firmId: 1, partyId: 1 });
JobWorkInvoiceSchema.index({ workspaceId: 1, firmId: 1, jwOutwardChallanId: 1 });
JobWorkInvoiceSchema.index({ workspaceId: 1, firmId: 1, financialYear: 1 });
JobWorkInvoiceSchema.index({ workspaceId: 1, firmId: 1, paymentStatus: 1 });
JobWorkInvoiceSchema.index(
  { workspaceId: 1, firmId: 1, voucherNumber: 1 },
  { unique: true, partialFilterExpression: { voucherNumber: { $type: 'string', $ne: '' } } },
);
