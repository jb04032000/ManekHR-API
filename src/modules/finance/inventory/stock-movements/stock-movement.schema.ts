import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type StockMovementDocument = HydratedDocument<StockMovement>;

export const MOVEMENT_TYPES = [
  'purchase_in',
  'sale_out',
  'dc_out',
  'so_reserve',
  'so_release',
  'transfer_in',
  'transfer_out',
  'wastage_out',
  'sample_out',
  'sample_return_in',
  'consignment_out',
  'consignment_return_in',
  'opening_stock',
  'grn_in',
  'purchase_return_out',
  'credit_note_in',
  'debit_note_out',
  'manufacturing_in',
  'manufacturing_out',
] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

@Schema({ timestamps: true })
export class StockMovement {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, enum: MOVEMENT_TYPES, required: true })
  movementType: MovementType;

  @Prop({ type: Types.ObjectId, ref: 'Item', required: true, index: true })
  itemId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true, index: true })
  godownId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lot' })
  lotId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Batch' })
  batchId?: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  serialNos: string[];

  // positive = inward, negative = outward (unified sign convention per D-01)
  @Prop({ type: Number, required: true })
  qty: number;

  // cost of goods moved in paise; 0 for reservation-only movements
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  costPaise: number;

  // snapshot of item's moving avg cost at time of movement (paise)
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  movingAvgCostPaise: number;

  @Prop({ type: Types.ObjectId })
  sourceVoucherId?: Types.ObjectId;

  @Prop({ type: String })
  sourceVoucherType?: string;

  @Prop({ type: String })
  sourceVoucherNumber?: string;

  @Prop({ type: String, maxlength: 500 })
  narration?: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;
}

export const StockMovementSchema = SchemaFactory.createForClass(StockMovement);

// Primary query index: movements per item at a godown in chronological order
StockMovementSchema.index({
  workspaceId: 1,
  firmId: 1,
  itemId: 1,
  godownId: 1,
  createdAt: -1,
});

// Lot traceability queries
StockMovementSchema.index({
  workspaceId: 1,
  firmId: 1,
  lotId: 1,
  createdAt: -1,
});

// Voucher-level movement lookup (e.g. reverse a voucher)
StockMovementSchema.index({
  workspaceId: 1,
  firmId: 1,
  sourceVoucherId: 1,
});
