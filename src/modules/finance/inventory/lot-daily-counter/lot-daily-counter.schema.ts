import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LotDailyCounterDocument = HydratedDocument<LotDailyCounter>;

@Schema({ collection: 'lot_daily_counters', timestamps: true })
export class LotDailyCounter {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Item', required: true, index: true })
  itemId: Types.ObjectId;

  /** Date string in YYYYMMDD format (e.g. "20260428") */
  @Prop({ type: String, required: true, maxlength: 8 })
  date: string;

  /** Monotonically increasing sequence; incremented atomically via $inc upsert */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  seq: number;
}

export const LotDailyCounterSchema =
  SchemaFactory.createForClass(LotDailyCounter);

// Compound unique index — ensures atomic $inc upsert is safe under concurrency
LotDailyCounterSchema.index(
  { workspaceId: 1, firmId: 1, itemId: 1, date: 1 },
  { unique: true },
);
