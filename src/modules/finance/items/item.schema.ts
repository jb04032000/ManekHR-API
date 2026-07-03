import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Item extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String })
  itemCode?: string;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ type: String, enum: ['goods', 'services'], required: true })
  itemType: string;

  @Prop({ type: String })
  hsnSacCode?: string;

  @Prop({ type: Number, enum: [0, 5, 12, 18, 28], default: 18 })
  gstRate: number;

  @Prop({ type: Number, default: 0 })
  cessRate: number;

  @Prop({ type: String, required: true })
  unit: string;

  @Prop({ type: Number, default: 2 })
  qtyDecimalPlaces: number;

  @Prop({ type: Boolean, default: false })
  trackBatch: boolean;

  @Prop({ type: Boolean, default: false })
  trackSerial: boolean;

  @Prop({ type: Boolean, default: true })
  trackStock: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Godown' })
  defaultGodownId?: Types.ObjectId;

  @Prop({ type: Number, default: 0 })
  movingAvgCostPaise: number;

  @Prop({ type: String })
  category?: string;

  @Prop({
    type: {
      qty: { type: Number },
      rate: { type: Number },
      asOfDate: { type: Date },
    },
  })
  openingStock?: { qty: number; rate: number; asOfDate: Date };

  @Prop({
    type: [
      {
        fromUnit: { type: String },
        toUnit: { type: String },
        factor: { type: Number },
      },
    ],
    default: [],
  })
  unitConversions: { fromUnit: string; toUnit: string; factor: number }[];

  @Prop({ type: Number, default: 0 })
  qtyOnHand: number; // available stock; decremented on Tax Invoice / DC post

  @Prop({ type: Number, default: 0 })
  reservedQty: number; // reserved by open Sale Orders; released on DC post or SO cancel

  @Prop({ type: Number, default: 0 })
  defaultRate: number; // in paise; line-item rate auto-fill source

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const ItemSchema = SchemaFactory.createForClass(Item);
ItemSchema.index({ workspaceId: 1, firmId: 1 });
ItemSchema.index({ workspaceId: 1, firmId: 1, isDeleted: 1 });
