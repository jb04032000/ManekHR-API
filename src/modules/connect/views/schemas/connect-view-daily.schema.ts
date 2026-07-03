import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect -- view-tracking target kinds. A view is recorded against a
 * storefront (its public page), a listing (a product detail view), or a
 * profile (a public /u/[slug] person page, targetId = the viewed User id).
 */
export type ConnectViewTargetType = 'storefront' | 'listing' | 'profile';
export const CONNECT_VIEW_TARGET_TYPES: ConnectViewTargetType[] = [
  'storefront',
  'listing',
  'profile',
];

/**
 * `ConnectViewDaily` -- one rollup row per (target, UTC day) holding that day's
 * view count. Summing a date range gives totals + a sparkline series without a
 * cron. Writes are an idempotent `$inc` upsert from the dedupe path in
 * `ConnectViewService.recordView`, so a single fresh impression bumps exactly
 * one day's counter.
 */
@Schema({ timestamps: false, collection: 'connect_view_daily' })
export class ConnectViewDaily extends Document {
  @Prop({ type: String, enum: CONNECT_VIEW_TARGET_TYPES, required: true })
  targetType: ConnectViewTargetType;

  @Prop({ type: Types.ObjectId, required: true })
  targetId: Types.ObjectId;

  /** UTC calendar day, 'YYYY-MM-DD'. */
  @Prop({ type: String, required: true })
  date: string;

  @Prop({ type: Number, default: 0 })
  count: number;
}

export const ConnectViewDailySchema = SchemaFactory.createForClass(ConnectViewDaily);

// One rollup row per (target, day) -- the $inc upsert key.
ConnectViewDailySchema.index({ targetType: 1, targetId: 1, date: 1 }, { unique: true });
