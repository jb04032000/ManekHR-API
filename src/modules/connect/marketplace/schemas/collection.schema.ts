import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { Storefront } from '../../entities/schemas/storefront.schema';

/**
 * ManekHR Connect Marketplace -- `Collection` (Shop Collections).
 *
 * An owner-curated, shop-scoped group of the shop's own products, for in-store
 * browsing (a saree shop's "Bridal", "Cotton dupattas", "Wholesale lots"). This
 * is distinct from the cross-shop marketplace `category` (discovery taxonomy)
 * and from the cross-shop product `tags` (discovery hashtags).
 *
 * PERSON-CENTRIC: owned by a Connect `User` (`ownerUserId`), never a workspace;
 * scoped to one `storefrontId`. Authorize by userId on every write.
 *
 * Membership is the SOURCE OF TRUTH on the product (`Listing.collectionIds`);
 * `productOrder` here is ONLY an advisory display order:
 *  - a member absent from `productOrder` sorts after, by recency;
 *  - an orphan id (product later removed) is ignored on read.
 * This keeps a single source of truth for membership (no two-document drift).
 *
 * Every `@Prop` carries an explicit `{ type }` -- required by `@nestjs/mongoose`
 * and the repo's Vitest SWC transform so `SchemaFactory.createForClass` resolves
 * without `emitDecoratorMetadata`.
 */
@Schema({ timestamps: true, collection: 'connect_collections' })
export class Collection extends Document {
  /** The shop this collection belongs to. */
  @Prop({ type: Types.ObjectId, ref: 'Storefront', required: true })
  storefrontId: Storefront | Types.ObjectId;

  /** The `User` who owns this collection (== the shop's owner). Person-centric. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerUserId: User | Types.ObjectId;

  /** Display title shown on the storefront + the owner console. */
  @Prop({ type: String, required: true, trim: true, maxlength: 80 })
  title: string;

  /** URL slug, unique PER storefront. Derived from the title, deduped. */
  @Prop({ type: String, required: true, trim: true, lowercase: true })
  slug: string;

  /** Optional blurb shown atop the collection on the public store. */
  @Prop({ type: String, trim: true, maxlength: 500, default: '' })
  description: string;

  /** Optional cover image (uploaded URL) for the collection card / banner. */
  @Prop({ type: String, trim: true, default: '' })
  coverImage: string;

  /** Order of this collection among the shop's collections (asc). */
  @Prop({ type: Number, default: 0 })
  sortIndex: number;

  /**
   * Advisory manual order of products inside this collection. NOT the membership
   * source of truth (that is `Listing.collectionIds`); only orders the members.
   */
  @Prop({ type: [Types.ObjectId], ref: 'Listing', default: [] })
  productOrder: Types.ObjectId[];

  // `createdAt` / `updatedAt` added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type CollectionDocument = Collection & Document;

export const CollectionSchema = SchemaFactory.createForClass(Collection);

// The shop's collection list, ordered.
CollectionSchema.index({ storefrontId: 1, sortIndex: 1 });
// Per-shop slug uniqueness + public lookup by slug.
CollectionSchema.index({ storefrontId: 1, slug: 1 }, { unique: true });
// Ownership scans.
CollectionSchema.index({ ownerUserId: 1 });
