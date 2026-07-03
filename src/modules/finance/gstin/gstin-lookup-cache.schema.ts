import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type GstinLookupCacheDocument = HydratedDocument<GstinLookupCache>;

/**
 * D6: cache of successful GSTIN provider lookups, keyed by GSTIN, so a repeat lookup never burns
 * another paid provider call. TTL-expired after 30 days so registration-status changes
 * (active -> cancelled) eventually refresh. Global (rates/registrations are not tenant-specific).
 */
@Schema({ collection: 'gstinlookupcache' })
export class GstinLookupCache {
  @Prop({ type: String, required: true, unique: true })
  gstin: string;

  @Prop({ type: Object, required: true })
  info: Record<string, unknown>;

  @Prop({ type: Date, default: Date.now })
  fetchedAt: Date;
}

export const GstinLookupCacheSchema = SchemaFactory.createForClass(GstinLookupCache);

// 30-day TTL: cached lookups auto-expire so status changes refresh on the next lookup.
GstinLookupCacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 2_592_000 });
