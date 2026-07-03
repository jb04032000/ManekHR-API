import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ItemValuationLayerDocument = HydratedDocument<ItemValuationLayer>;

/**
 * FIFO cost layer per item per godown (D-04).
 *
 * CRITICAL (pitfall 2 from RESEARCH.md): The FIFO query is:
 *   find({ ws, firm, item, godown, isExhausted: false }).sort({ seq: 1 })
 * The compound index MUST have isExhausted before seq so MongoDB uses IXSCAN
 * rather than COLLSCAN + filter on exhausted layers.
 */
@Schema({ timestamps: true })
export class ItemValuationLayer {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  godownId: Types.ObjectId;

  // FIFO consumption order — lowest seq consumed first
  @Prop({ type: Number, required: true })
  seq: number;

  @Prop({ type: Number, required: true, min: 0 })
  qtyOriginal: number;

  @Prop({ type: Number, required: true, min: 0 })
  qtyRemaining: number;

  // cost per unit in paise
  @Prop({ type: Number, required: true, min: 0 })
  costPaise: number;

  @Prop({ type: Date, required: true })
  inDate: Date;

  @Prop({ type: Types.ObjectId, ref: 'StockMovement', required: true })
  sourceMovementId: Types.ObjectId;

  // set to true when qtyRemaining === 0; index filter eliminates exhausted layers
  @Prop({ type: Boolean, default: false })
  isExhausted: boolean;
}

export const ItemValuationLayerSchema =
  SchemaFactory.createForClass(ItemValuationLayer);

// FIFO consumption query index (CRITICAL — pitfall 2):
// isExhausted MUST come before seq so MongoDB uses IXSCAN on active layers only
ItemValuationLayerSchema.index({
  workspaceId: 1,
  firmId: 1,
  itemId: 1,
  godownId: 1,
  isExhausted: 1,
  seq: 1,
});

// Source movement lookup — e.g. void a layer when reversing a voucher
ItemValuationLayerSchema.index({ sourceMovementId: 1 });
