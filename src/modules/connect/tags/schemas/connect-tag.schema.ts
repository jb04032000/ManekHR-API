import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * ManekHR Connect — `ConnectTag` taxonomy (S1.3).
 *
 * The shared tag vocabulary behind hashtags, search, autocomplete, and trending.
 * Hybrid model: a curated textile taxonomy (`isCurated: true`, seeded) plus open
 * user-emergent tags (`isCurated: false`, created on first use) so a term we
 * never anticipated still becomes first-class and searchable.
 *
 * Every `@Prop` carries an explicit `{ type }` for the repo's Vitest SWC
 * transform so `SchemaFactory.createForClass` resolves without
 * `emitDecoratorMetadata`.
 */

export const CONNECT_TAG_CATEGORIES = [
  'material',
  'technique',
  'role',
  'product',
  'generic',
] as const;
export type ConnectTagCategory = (typeof CONNECT_TAG_CATEGORIES)[number];

/**
 * Per-locale display labels. `en` plus the romanized locales are populated for
 * curated tags; native Gujarati (`gu`) is enriched over time. A missing locale
 * falls back to `en`, then to the slug (see `TagService`).
 */
@Schema({ _id: false })
export class ConnectTagLabels {
  @Prop({ type: String, trim: true })
  en?: string;

  /** Gujarati, native script. */
  @Prop({ type: String, trim: true })
  gu?: string;

  /** Gujarati, romanized (locale `gu-en`). */
  @Prop({ type: String, trim: true })
  guEn?: string;

  /** Hindi, romanized (locale `hi-en`). */
  @Prop({ type: String, trim: true })
  hiEn?: string;
}
export const ConnectTagLabelsSchema = SchemaFactory.createForClass(ConnectTagLabels);

@Schema({ timestamps: true, collection: 'connecttags' })
export class ConnectTag extends Document {
  /** Canonical slug, lowercase + unique. Stored on `post.hashtags` and used in search. */
  @Prop({ type: String, required: true, trim: true, lowercase: true, unique: true })
  slug: string;

  /** Per-locale display labels. Falls back to `en`, then `slug`. */
  @Prop({ type: ConnectTagLabelsSchema, default: () => ({}) })
  labels: ConnectTagLabels;

  /** Alternate spellings / synonyms (lowercase) that resolve to this slug. */
  @Prop({ type: [String], default: [] })
  aliases: string[];

  /** Coarse grouping for facets + curation. */
  @Prop({ type: String, enum: CONNECT_TAG_CATEGORIES, default: 'generic' })
  category: ConnectTagCategory;

  /** Lifetime mention count; ranks autocomplete. Trending (S1.4) aggregates posts, not this. */
  @Prop({ type: Number, default: 0, min: 0 })
  usageCount: number;

  /** Velocity-over-baseline trending score, written by the S1.4 cron. */
  @Prop({ type: Number, default: 0 })
  trendingScore: number;

  /** True for the curated seed taxonomy; false for open user-emergent tags. */
  @Prop({ type: Boolean, default: false })
  isCurated: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ConnectTagSchema = SchemaFactory.createForClass(ConnectTag);

// `slug` unique index is declared on the @Prop. These cover alias resolution
// (normalizeHashtags), autocomplete ranking, and trending reads (S1.4).
ConnectTagSchema.index({ aliases: 1 });
ConnectTagSchema.index({ usageCount: -1 });
ConnectTagSchema.index({ trendingScore: -1 });
