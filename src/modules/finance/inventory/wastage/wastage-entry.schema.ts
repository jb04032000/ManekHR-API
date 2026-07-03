import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// ─── WastageReasonCode enum (D-06) ───────────────────────────────────────────

export const WASTAGE_REASON_CODES = [
  'manufacturing_damage',
  'transit_damage',
  'quality_rejection',
  'theft',
  'expiry',
  'processing_loss',
  'colour_bleeding',
  'cutting_loss',
  'fire_or_flood',
  'other',
] as const;

export type WastageReasonCode = (typeof WASTAGE_REASON_CODES)[number];

// ─── WastageEntryLine sub-document ───────────────────────────────────────────

@Schema({ _id: false })
export class WastageEntryLine {
  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lot' })
  lotId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Batch' })
  batchId?: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  qty: number;

  @Prop({
    type: String,
    enum: ['own_goods', 'job_work_material'],
    required: true,
  })
  wastageType: 'own_goods' | 'job_work_material';

  @Prop({ type: String, enum: WASTAGE_REASON_CODES, required: true })
  reasonCode: WastageReasonCode;

  @Prop({ type: String, maxlength: 500 })
  remarks?: string;

  /** Resolved at post time from Item.movingAvgCostPaise × qty (paise) */
  @Prop({ type: Number, required: true, min: 0, default: 0 })
  costPaise: number;
}

const WastageEntryLineSchema = SchemaFactory.createForClass(WastageEntryLine);

// ─── WastageAuditEntry sub-document ──────────────────────────────────────────

@Schema({ _id: false })
export class WastageAuditEntry {
  @Prop({ type: Date, default: Date.now })
  at: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  by: Types.ObjectId;

  @Prop({ type: String, required: true })
  action: string;
}

const WastageAuditEntrySchema = SchemaFactory.createForClass(WastageAuditEntry);

// ─── WastageEntry document ────────────────────────────────────────────────────

@Schema({ collection: 'wastage_entries', timestamps: true })
export class WastageEntry {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  /** Voucher number: WE/{FY-short}/{seq} e.g. "WE/25-26/0001" */
  @Prop({ type: String, required: true })
  voucherNo: string;

  @Prop({ type: Date, required: true })
  date: Date;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  godownId: Types.ObjectId;

  @Prop({ type: [WastageEntryLineSchema], default: [] })
  lines: WastageEntryLine[];

  /** Sum of all line costs in paise (resolved at post time) */
  @Prop({ type: Number, required: true, default: 0 })
  totalCostPaise: number;

  @Prop({ type: String, maxlength: 1000 })
  narration?: string;

  /** Link to LedgerEntry created on post (only set for own_goods totals > 0) */
  @Prop({ type: Types.ObjectId, ref: 'LedgerEntry' })
  ledgerEntryId?: Types.ObjectId;

  /**
   * F-10 traceback: Manufacturing Voucher (or other caller) that triggered this wastage.
   * Populated by WastageService.createPosted when called from an external voucher.
   */
  @Prop({ type: Types.ObjectId })
  sourceVoucherId?: Types.ObjectId;

  @Prop({ type: String })
  sourceVoucherType?: string;

  @Prop({ type: String })
  sourceVoucherNumber?: string;

  @Prop({ type: String, enum: ['draft', 'posted'], default: 'draft' })
  status: 'draft' | 'posted';

  @Prop({ type: Types.ObjectId, ref: 'User' })
  postedBy?: Types.ObjectId;

  @Prop({ type: Date })
  postedAt?: Date;

  @Prop({ type: [WastageAuditEntrySchema], default: [] })
  auditLog: WastageAuditEntry[];

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const WastageEntrySchema = SchemaFactory.createForClass(WastageEntry);

// Unique voucher number per firm (T-09-06-05: workspaceId+firmId scoped)
WastageEntrySchema.index(
  { workspaceId: 1, firmId: 1, voucherNo: 1 },
  { unique: true },
);

// List / date-range queries
WastageEntrySchema.index({ workspaceId: 1, firmId: 1, date: -1 });

export type WastageEntryDocument = HydratedDocument<WastageEntry>;
