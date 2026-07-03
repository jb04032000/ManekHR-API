import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type GodownBalanceDocument = HydratedDocument<GodownBalance>;

/**
 * bucketType discriminator (D-07 Open Question #2 resolution):
 * The same item can have stock balance, sample-out balance, and consignment-out
 * balance simultaneously per godown. Default 'stock' keeps backward compat.
 */
export const BUCKET_TYPES = ['stock', 'sample', 'consignment'] as const;
export type BucketType = (typeof BUCKET_TYPES)[number];

@Schema({ timestamps: true })
export class GodownBalance {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  godownId: Types.ObjectId;

  @Prop({ type: String, enum: BUCKET_TYPES, default: 'stock', required: true })
  bucketType: BucketType;

  // current balance; CAN be negative — short-stock allowed per D-01
  // NOTE: no min:0 constraint here (negative qty permitted per D-01 + pitfall 4)
  @Prop({ type: Number, required: true, default: 0 })
  qty: number;

  @Prop({ type: Date })
  lastMovementAt?: Date;
}

export const GodownBalanceSchema = SchemaFactory.createForClass(GodownBalance);

// Unique compound index extended with bucketType discriminator
// Allows stock + sample + consignment buckets to coexist for the same {item, godown}
GodownBalanceSchema.index(
  { workspaceId: 1, firmId: 1, itemId: 1, godownId: 1, bucketType: 1 },
  { unique: true },
);
