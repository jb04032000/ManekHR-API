import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * ManekHR Connect Ads -- `AdPlacement` collection.
 *
 * Global seeded slots that define WHERE ads can be served. There is no
 * `workspaceId` -- placements are platform-wide configuration managed by
 * the zari360 admin team, not by individual advertisers.
 *
 * Example seeded rows:
 *   { key: 'feed_promoted_post', surface: 'feed', floorCpm: 5, enabled: true }
 *   { key: 'rail_spotlight',     surface: 'rail', floorCpm: 8, enabled: false }
 *
 * `key` is unique (enforced at the `@Prop` level -- no separate `.index()`
 * declaration because the prop-level flag is the single source of truth).
 */
@Schema({ timestamps: true, collection: 'ad_placements' })
export class AdPlacement extends Document {
  /**
   * Stable machine key referenced by `AdSet.placements` and `AdImpression.placementKey`.
   * Examples: 'feed_promoted_post', 'rail_spotlight'.
   */
  @Prop({ type: String, required: true, unique: true })
  key: string;

  /** UI surface where the placement appears. */
  @Prop({ type: String, enum: ['feed', 'rail'], required: true })
  surface: string;

  /** Minimum CPM (credits per 1 000 impressions) accepted for this slot. */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  floorCpm: number;

  /** When `false`, the slot is not eligible for delivery and is hidden from the campaign UI. */
  @Prop({ type: Boolean, required: true, default: true })
  enabled: boolean;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type AdPlacementDocument = AdPlacement & Document;

export const AdPlacementSchema = SchemaFactory.createForClass(AdPlacement);

// `unique: true` on the `key` @Prop already creates the unique index.
// No duplicate declaration here -- the prop-level flag is the single source of truth.
