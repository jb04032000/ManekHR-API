import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

// ─── GrnReturnLine sub-document ──────────────────────────────────────────────

@Schema({ _id: false })
export class GrnReturnLine {
  @Prop({ type: Types.ObjectId }) itemId?: Types.ObjectId;
  @Prop({ type: String }) itemName?: string;
  @Prop({ type: Number }) qtyReturned?: number;
  @Prop({ type: String }) unit?: string;
  @Prop({ type: Number }) ratePaise?: number;
  @Prop({ type: String }) reason?: string;
  @Prop({ type: String }) batchNumber?: string;
  @Prop({ type: String }) notes?: string;
}
export const GrnReturnLineSchema = SchemaFactory.createForClass(GrnReturnLine);

// ─── GrnReturn document (financial-neutral physical return — NO LedgerPosting) ─

/**
 * GrnReturn is a WAREHOUSE-ONLY document.
 * It does NOT inject LedgerPostingService and has NO ledgerEntryIds field.
 * Financial effects (Debit Note) are tracked via linkedDebitNoteId.
 * Mirrors the design philosophy of GoodsReceiptNote (grn.schema.ts).
 */
@Schema({ timestamps: true, collection: 'grnreturns' })
export class GrnReturn extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, enum: ['grn_return'], default: 'grn_return' })
  voucherType: string;

  @Prop({ type: String, index: true })
  voucherNumber?: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({ type: String, required: true })
  financialYear: string;

  @Prop({
    type: String,
    enum: ['draft', 'dispatched', 'confirmed', 'cancelled'],
    default: 'draft',
  })
  state: string;

  // ── Source references (all optional — GRN-Return can reference GRN, Bill, or be standalone) ──
  @Prop({ type: Types.ObjectId })
  sourceGrnId?: Types.ObjectId;

  @Prop({ type: String })
  sourceGrnNumber?: string;

  @Prop({ type: Types.ObjectId })
  sourceBillId?: Types.ObjectId;

  @Prop({ type: String })
  sourceBillNumber?: string;

  // ── Linked financial document (set when DN is created from this GRN-Return) ──
  @Prop({ type: Types.ObjectId })
  linkedDebitNoteId?: Types.ObjectId;

  @Prop({ type: String })
  linkedDebitNoteNumber?: string;

  // ── Vendor ────────────────────────────────────────────────────────────────
  @Prop({ type: Types.ObjectId, ref: 'Party' })
  partyId?: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  partySnapshot?: Record<string, any>;

  /** Vendor's own return merchandise authorization number */
  @Prop({ type: String })
  vendorRmaNumber?: string;

  // ── Transport details sub-doc (for delivery challan) ──────────────────────
  @Prop({
    type: {
      carrier: { type: String },
      lrNumber: { type: String },
      dispatchDate: { type: Date },
    },
  })
  transport?: {
    carrier?: string;
    lrNumber?: string;
    dispatchDate?: Date;
  };

  @Prop({ type: [GrnReturnLineSchema], default: [] })
  lineItems: GrnReturnLine[];

  @Prop({ type: String }) notes?: string;
  @Prop({ type: Types.ObjectId }) dispatchedBy?: Types.ObjectId;
  @Prop({ type: Date }) dispatchedAt?: Date;
  @Prop({ type: Types.ObjectId }) confirmedBy?: Types.ObjectId;
  @Prop({ type: Date }) confirmedAt?: Date;
  @Prop({ type: Types.ObjectId }) cancelledBy?: Types.ObjectId;
  @Prop({ type: Date }) cancelledAt?: Date;
  @Prop({ type: String }) cancellationReason?: string;
  @Prop({ type: Array, default: [] }) auditLog: any[];
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
}

export const GrnReturnSchema = SchemaFactory.createForClass(GrnReturn);

GrnReturnSchema.index({ workspaceId: 1, firmId: 1, voucherDate: -1 });
GrnReturnSchema.index({ workspaceId: 1, firmId: 1, sourceGrnId: 1 });
GrnReturnSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, state: 1 });
GrnReturnSchema.index(
  { workspaceId: 1, firmId: 1, voucherNumber: 1, financialYear: 1 },
  { unique: true, partialFilterExpression: { state: { $in: ['dispatched', 'confirmed'] } } },
);
