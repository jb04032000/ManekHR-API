import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SerialDocument = HydratedDocument<Serial>;

export const SERIAL_STATUSES = [
  'in_stock',
  'sold',
  'sample_out',
  'returned',
  'scrapped',
] as const;

export type SerialStatus = (typeof SERIAL_STATUSES)[number];

/**
 * Serial entity (D-03): individual unit serial number tracking.
 * Created when Item.trackSerial=true on purchase inward.
 * serialNo is unique per {workspaceId, firmId, itemId}.
 */
@Schema({ timestamps: true })
export class Serial {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 100 })
  serialNo: string;

  @Prop({ type: String, enum: SERIAL_STATUSES, default: 'in_stock' })
  status: SerialStatus;

  @Prop({ type: Date })
  purchasedAt?: Date;

  @Prop({ type: Date })
  soldAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'Godown' })
  currentGodownId?: Types.ObjectId;

  // lot this serial came from (optional link)
  @Prop({ type: Types.ObjectId })
  lotId?: Types.ObjectId;

  // batch this serial came from (optional link)
  @Prop({ type: Types.ObjectId })
  batchId?: Types.ObjectId;

  // voucher that created or last consumed this serial
  @Prop({ type: Types.ObjectId })
  sourceVoucherId?: Types.ObjectId;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const SerialSchema = SchemaFactory.createForClass(Serial);

// Unique compound: serialNo must be unique per item per firm (excluding soft-deleted)
SerialSchema.index(
  { workspaceId: 1, firmId: 1, itemId: 1, serialNo: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Status-based filtering (e.g. list all in_stock serials for an item)
SerialSchema.index({ workspaceId: 1, firmId: 1, status: 1 });
