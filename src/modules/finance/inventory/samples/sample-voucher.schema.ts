import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// ─── Embedded sub-schemas ────────────────────────────────────────────────────

@Schema({ _id: false })
export class SampleVoucherLine {
  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  godownId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lot' })
  lotId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Batch' })
  batchId?: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  serialNos: string[];

  @Prop({ type: Number, required: true, min: 0 })
  qty: number;

  @Prop({ type: Number, default: 0, min: 0 })
  acceptedQty: number;

  @Prop({ type: Number, default: 0, min: 0 })
  returnedQty: number;

  /** Indicative rate per unit in paise */
  @Prop({ type: Number, min: 0 })
  rate?: number;

  @Prop({ type: String, maxlength: 500 })
  remarks?: string;
}

@Schema({ _id: false })
export class SampleAuditEntry {
  @Prop({ type: Date, default: Date.now })
  at: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  by: Types.ObjectId;

  @Prop({ type: String, required: true })
  action: string;

  @Prop({ type: Object })
  before?: any;

  @Prop({ type: Object })
  after?: any;
}

// ─── Root schema ─────────────────────────────────────────────────────────────

/**
 * SampleVoucher — D-07 Sample / Consignment voucher
 *
 * State machine:
 *   draft → sent → partially_accepted → fully_accepted
 *                                      ↘ rejected_returned
 *                → overdue   (flipped by cron when expectedReturnDate < now)
 *
 * RATIONALE for 'draft' state: D-07 lists transitions starting from 'sent',
 * but every other voucher in this project (StockTransfer, WastageEntry, SaleInvoice)
 * uses a 'draft' pre-post state. 'draft' is added for consistency; it is promoted to
 * 'sent' on the post() action. No D-07 transition is altered.
 */
@Schema({ collection: 'sample_vouchers', timestamps: true })
export class SampleVoucher {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  /** Auto-generated number e.g. SV/25-26/0001 */
  @Prop({ type: String, required: true })
  voucherNo: string;

  @Prop({ type: String, enum: ['sample', 'consignment'], required: true })
  sampleType: 'sample' | 'consignment';

  @Prop({ type: Date, required: true })
  date: Date;

  @Prop({ type: Types.ObjectId, ref: 'Party', required: true })
  partyId: Types.ObjectId;

  @Prop({ type: String, maxlength: 500 })
  deliveryAddress?: string;

  @Prop({ type: [SampleVoucherLine], default: [] })
  lines: SampleVoucherLine[];

  @Prop({ type: Date, required: true })
  expectedReturnDate: Date;

  /** Number of days before expectedReturnDate to start alarm notifications (D-07) */
  @Prop({ type: Number, required: true, default: 7, min: 1 })
  autoAlarmDays: number;

  @Prop({
    type: String,
    enum: ['draft', 'sent', 'partially_accepted', 'fully_accepted', 'rejected_returned', 'overdue'],
    default: 'draft',
  })
  status: string;

  /** Set when accept() creates a Tax Invoice draft from this sample (F-09-08) */
  @Prop({ type: Types.ObjectId, ref: 'SaleInvoice' })
  acceptedInvoiceId?: Types.ObjectId;

  @Prop({ type: Date })
  returnedAt?: Date;

  @Prop({ type: Date })
  postedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  postedBy?: Types.ObjectId;

  @Prop({ type: String, maxlength: 1000 })
  narration?: string;

  @Prop({ type: [SampleAuditEntry], default: [] })
  auditLog: SampleAuditEntry[];

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const SampleVoucherSchema = SchemaFactory.createForClass(SampleVoucher);

// Unique constraint: no duplicate voucher numbers per firm
SampleVoucherSchema.index({ workspaceId: 1, firmId: 1, voucherNo: 1 }, { unique: true });

// Cron scan index: filter status + date without loading all vouchers
SampleVoucherSchema.index({ workspaceId: 1, firmId: 1, status: 1, expectedReturnDate: 1 });

// Party-level queries
SampleVoucherSchema.index({ workspaceId: 1, firmId: 1, partyId: 1 });

export type SampleVoucherDocument = HydratedDocument<SampleVoucher>;
