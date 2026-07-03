import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// ─── MvComponentLine sub-document ────────────────────────────────────────────
// Snapshot of BoM component at MV creation time (immutable after issue) — D-02

@Schema({ _id: false })
export class MvComponentLine {
  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  plannedQty: number;

  @Prop({ type: String, required: true })
  unit: string;

  @Prop({ type: Number, default: 0, min: 0, max: 100 })
  wastageAllowedPct: number;
}

export const MvComponentLineSchema = SchemaFactory.createForClass(MvComponentLine);

// ─── MvComponentConsumed sub-document ────────────────────────────────────────
// Actual consumption filled on Issue Materials (Stage 2) — D-02

@Schema({ _id: false })
export class MvComponentConsumed {
  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  qty: number;

  @Prop({ type: String, required: true })
  unit: string;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  godownId: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  lotId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  batchId?: Types.ObjectId;

  @Prop({ type: [String] })
  serialNos?: string[];

  @Prop({ type: Number, required: true, min: 0 })
  costAtConsumptionPaise: number;
}

export const MvComponentConsumedSchema = SchemaFactory.createForClass(MvComponentConsumed);

// ─── MvAdditionalCost sub-document ───────────────────────────────────────────
// Overhead allocation on MV (labor, power, consumables) — D-07

@Schema({ _id: false })
export class MvAdditionalCost {
  @Prop({ type: Types.ObjectId, ref: 'Account', required: true })
  accountId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  amountPaise: number;

  @Prop({ type: String })
  narration?: string;
}

export const MvAdditionalCostSchema = SchemaFactory.createForClass(MvAdditionalCost);

// ─── MvByProduct sub-document ────────────────────────────────────────────────
// By-products actually produced on completion — D-08

@Schema({ _id: false })
export class MvByProduct {
  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  qty: number;

  @Prop({ type: String, required: true })
  unit: string;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  godownId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  costAllocatedPaise: number;
}

export const MvByProductSchema = SchemaFactory.createForClass(MvByProduct);

// ─── ManufacturingVoucher root document ──────────────────────────────────────

export type ManufacturingVoucherDocument = HydratedDocument<ManufacturingVoucher>;

@Schema({ timestamps: true, collection: 'manufacturingvouchers' })
export class ManufacturingVoucher {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  /**
   * From VoucherSeries 'manufacturing_voucher'. Empty string on draft; assigned on Issue Materials (D-10).
   * Partial unique index prevents collision across multiple drafts with empty voucherNumber.
   */
  @Prop({ type: String, required: false, trim: true, default: '' })
  voucherNumber: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  /** Two-stage lifecycle: draft → in_progress → completed (or cancelled) — D-03 */
  @Prop({
    type: String,
    enum: ['draft', 'in_progress', 'completed', 'cancelled'],
    default: 'draft',
    required: true,
  })
  status: 'draft' | 'in_progress' | 'completed' | 'cancelled';

  /** Linked BoM (D-02) */
  @Prop({ type: Types.ObjectId, ref: 'BomDefinition', required: true })
  bomId: Types.ObjectId;

  /** BoM version captured at MV creation time — snapshot semantics (D-11) */
  @Prop({ type: Number, required: true })
  bomVersionNo: number;

  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  finishedItemId: Types.ObjectId;

  /** Planned qty to produce */
  @Prop({ type: Number, required: true, min: 0 })
  finishedQty: number;

  @Prop({ type: String, required: true })
  finishedUnit: string;

  /** Godown where FG will be stocked */
  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  finishedGodownId: Types.ObjectId;

  /** Auto-generated or user-supplied; links to Batch record (D-09) */
  @Prop({ type: String })
  batchNo?: string;

  /** Snapshot of components from BoM at creation time (immutable after issue) */
  @Prop({ type: [MvComponentLineSchema], default: [] })
  componentsPlanned: MvComponentLine[];

  /** Filled in on issue (in_progress) — may differ from planned */
  @Prop({ type: [MvComponentConsumedSchema], default: [] })
  componentsConsumed: MvComponentConsumed[];

  /** Overhead / additional costs allocated into WIP */
  @Prop({ type: [MvAdditionalCostSchema], default: [] })
  additionalCosts: MvAdditionalCost[];

  /** By-products actually produced on completion */
  @Prop({ type: [MvByProductSchema], default: [] })
  byProductsProduced: MvByProduct[];

  /** Costing mode: actual (default) or standard — D-05 */
  @Prop({
    type: String,
    enum: ['actual', 'standard'],
    default: 'actual',
    required: true,
  })
  costMethod: 'actual' | 'standard';

  /** Sum of raw material cost at actual lot cost + overhead (paise) */
  @Prop({ type: Number, default: 0, min: 0 })
  totalInputCostPaise: number;

  /**
   * Per-unit standard FG cost (BoM batch standard cost / outputQty) — only for
   * costMethod='standard' (paise). The completion ledger posts the FG debit as
   * standardFgCostPaise * actualFinishedQty and the residual as variance.
   */
  @Prop({ type: Number })
  standardFgCostPaise?: number;

  /** FG stock value posted to Finished Goods account (paise) */
  @Prop({ type: Number, default: 0 })
  totalOutputCostPaise: number;

  /** totalInputCost − totalOutputCost; can be negative (favorable variance) */
  @Prop({ type: Number, default: 0 })
  variancePaise: number;

  /** Actual qty produced (may be less than finishedQty for partial completion) */
  @Prop({ type: Number, default: 0, min: 0 })
  actualFinishedQty: number;

  /**
   * Ledger entry IDs: [0] = issue posting, [1] = completion posting.
   * Same pattern as stock-transfer.schema.ts (ledgerEntryId → here an array for 2 entries).
   */
  @Prop({ type: [Types.ObjectId], default: [] })
  ledgerEntryIds: Types.ObjectId[];

  /** Back-link to Batch created on Issue Materials (D-09) */
  @Prop({ type: Types.ObjectId })
  batchRecordId?: Types.ObjectId;

  @Prop({ type: Date })
  issuedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  issuedBy?: Types.ObjectId;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  completedBy?: Types.ObjectId;

  @Prop({ type: Date })
  cancelledAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  cancelledBy?: Types.ObjectId;

  @Prop({ type: String })
  narration?: string;

  /** F-11 D-18: karigars who worked on this MV (optional, backward-compatible) */
  @Prop({ type: [Types.ObjectId], ref: 'TeamMember', default: [] })
  karigarIds: Types.ObjectId[];

  /** F-11 D-18: machines used (optional) — Machine entity arrives in Machines v2.0 */
  @Prop({ type: [Types.ObjectId], default: [] })
  machineIds: Types.ObjectId[];

  /** F-11 D-18: shift during which MV was performed (optional) */
  @Prop({ type: Types.ObjectId, ref: 'Shift' })
  shiftId?: Types.ObjectId;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;
}

export const ManufacturingVoucherSchema = SchemaFactory.createForClass(ManufacturingVoucher);

// ─── D-02 Indexes ─────────────────────────────────────────────────────────────

/** Filter by status */
ManufacturingVoucherSchema.index({ workspaceId: 1, firmId: 1, status: 1 });

/** Date-sorted list */
ManufacturingVoucherSchema.index({ workspaceId: 1, firmId: 1, voucherDate: -1 });

/** Per-item production history */
ManufacturingVoucherSchema.index({ workspaceId: 1, firmId: 1, finishedItemId: 1 });

/**
 * Unique voucher number per firm — partial filter excludes empty-string drafts
 * so multiple drafts with voucherNumber='' don't violate uniqueness.
 */
ManufacturingVoucherSchema.index(
  { workspaceId: 1, firmId: 1, voucherNumber: 1 },
  { unique: true, partialFilterExpression: { voucherNumber: { $type: 'string', $ne: '' } } },
);
