import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type BatchDocument = HydratedDocument<Batch>;

/**
 * Batch entity (D-03): production-based tracking.
 * Created by Manufacturing Voucher in F-10; stubbed here for F-09 schema foundation.
 * Each production run creates a Batch, linked to a BoM (bomId — F-10).
 */
@Schema({ timestamps: true })
export class Batch {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 100 })
  batchNo: string;

  @Prop({ type: Date })
  mfgDate?: Date;

  @Prop({ type: Date })
  expiryDate?: Date;

  // BoM that produced this batch — linked in F-10 Manufacturing Voucher
  @Prop({ type: Types.ObjectId })
  bomId?: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  qtyProduced: number;

  @Prop({ type: Number, required: true, min: 0 })
  qtyRemaining: number;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  godownId: Types.ObjectId;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const BatchSchema = SchemaFactory.createForClass(Batch);

// Unique batchNo per firm (excluding soft-deleted)
BatchSchema.index(
  { workspaceId: 1, firmId: 1, batchNo: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Per-item batch listing
BatchSchema.index({ workspaceId: 1, firmId: 1, itemId: 1 });
