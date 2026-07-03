import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LotDocument = HydratedDocument<Lot>;

/**
 * Lot entity (D-03): receipt-based tracking, maps to embroidery "bardaan".
 * Each inward shipment (GRN / purchase bill) creates a Lot when Item.trackBatch=true.
 * lotNo is auto-generated as "{itemCode}-{YYYYMMDD}-{seq}" or user-supplied.
 */
@Schema({ timestamps: true })
export class Lot {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 100 })
  lotNo: string;

  @Prop({ type: Date, required: true })
  inwardDate: Date;

  @Prop({ type: Date })
  expiryDate?: Date;

  @Prop({ type: Date })
  mfgDate?: Date;

  @Prop({ type: Types.ObjectId, ref: 'Party' })
  supplierId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  sourceVoucherId?: Types.ObjectId;

  @Prop({ type: String })
  sourceVoucherType?: string;

  @Prop({ type: Number, required: true, min: 0 })
  qtyInward: number;

  @Prop({ type: Number, required: true, min: 0 })
  qtyRemaining: number;

  // weight in declared unit (g or kg); for fabric/yarn lots
  @Prop({ type: Number, min: 0 })
  weight?: number;

  @Prop({ type: String, enum: ['g', 'kg'] })
  weightUnit?: string;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  godownId: Types.ObjectId;

  @Prop({ type: String, maxlength: 500 })
  remarks?: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const LotSchema = SchemaFactory.createForClass(Lot);

// Per-item lot listing
LotSchema.index({ workspaceId: 1, firmId: 1, itemId: 1 });

// Unique lotNo per firm (excluding soft-deleted)
LotSchema.index(
  { workspaceId: 1, firmId: 1, lotNo: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Expiry-soon queries (Lot Registry color-coded expiry)
LotSchema.index({ workspaceId: 1, firmId: 1, expiryDate: 1 });
