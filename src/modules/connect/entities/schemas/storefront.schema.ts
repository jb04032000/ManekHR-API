import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import {
  ENTITY_VISIBILITIES,
  type EntityVisibility,
  EntityLocation,
  EntityLocationSchema,
} from './entity-common';

/**
 * ManekHR Connect -- `Storefront` (Phase 4 entity). A business's SHOP: the
 * branded home for the products (marketplace `Listing`s) it sells. Optional (0,
 * 1, or many per user) and independent: it MAY link to a CompanyPage
 * (`companyPageId`, set via the "Start selling" quick-setup that prefills from
 * the company details) or be fully standalone. Public URL `/store/[slug]`,
 * admin `/connect/store/[slug]/manage`.
 *
 * Products belong to a storefront: a `Listing` gains a required `storefrontId`
 * (Wave 3). The storefront's public page shows its own listings; the shared
 * marketplace still aggregates listings across ALL storefronts for discovery.
 *
 * Person-centric: owned by one `User`. The ERP-linked badge is DERIVED from
 * `erpWorkspaceId` via `ErpLinkService` at read time, never stored.
 */
@Schema({ timestamps: true, collection: 'connect_storefronts' })
export class Storefront extends Document {
  /** The `User` who owns + admins this shop. Person-centric -- never a workspace. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerUserId: User | Types.ObjectId;

  /** Unique URL slug -- the public page is `/store/[slug]`. */
  @Prop({ type: String, required: true, trim: true, lowercase: true, maxlength: 80 })
  slug: string;

  /** Shop display name. */
  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  name: string;

  /** Logo image URL. */
  @Prop({ type: String, trim: true, default: '' })
  logo: string;

  /** Banner image URL. */
  @Prop({ type: String, trim: true, default: '' })
  banner: string;

  /** Shop description prose. */
  @Prop({ type: String, trim: true, maxlength: 5000, default: '' })
  description: string;

  /** The textile categories this shop sells in (free tags; align to LISTING_CATEGORIES). */
  @Prop({ type: [String], default: [] })
  categories: string[];

  /** Where the shop is based. */
  @Prop({ type: EntityLocationSchema, default: () => ({}) })
  location: EntityLocation;

  /**
   * OPTIONAL link to one of the owner's CompanyPages. Set when the shop is
   * opened via "Start selling" from a company page (prefilled). `null` =
   * standalone shop, not tied to any business identity.
   */
  @Prop({ type: Types.ObjectId, ref: 'CompanyPage', default: null })
  companyPageId?: Types.ObjectId | null;

  /**
   * OPTIONAL ERP link. When set, the ERP-linked badge is DERIVED via
   * `ErpLinkService` (never stored). `null` = no link.
   *
   * As of the consent-first verification work (ADR-0004 / 2026-06-18 spec) this
   * pointer is set ONLY through the ownership-checked link path
   * (`StorefrontService.linkErpWorkspace`) — the create/update DTOs no longer
   * accept it raw. The companion `erpLink` sub-doc below carries the link's
   * consent record; this stays the read field the derivation uses.
   */
  @Prop({ type: Types.ObjectId, ref: 'Workspace', default: null })
  erpWorkspaceId?: Types.ObjectId | null;

  /**
   * ERP-link consent + ownership record (consent-first verification). Identical
   * shape + semantics to `CompanyPage.erpLink`: set by `linkErpWorkspace` after
   * an `isWorkspaceOwner` check; cleared on owner unlink, entity delete, account
   * erasure, or the `workspace.deleted` cascade. Reads count ERP activity ONLY
   * when `status === 'verified'`. `null` = never linked (no badge) — the default
   * for every legacy storefront, so no migration is needed. Sub-doc has no own
   * `_id`.
   */
  @Prop({
    type: {
      status: { type: String },
      linkedByUserId: { type: Types.ObjectId },
      linkedAt: { type: Date },
      consentVersion: { type: String },
    },
    default: null,
    _id: false,
  })
  erpLink?: {
    status: 'verified' | 'revoked';
    linkedByUserId: Types.ObjectId;
    linkedAt: Date | null;
    consentVersion: string;
  } | null;

  /** Public exposure. */
  @Prop({ type: String, enum: ENTITY_VISIBILITIES, default: 'public' })
  visibility: EntityVisibility;

  /**
   * The owner's pinned / primary shop. Exactly one of an owner's storefronts is
   * primary at a time -- `setPrimary` clears the flag on all of the owner's
   * shops then sets it on the chosen one. Drives the dashboard's "default shop"
   * highlight + the pre-selected storefront when opening the listing composer.
   */
  @Prop({ type: Boolean, default: false })
  isPrimary: boolean;

  // `createdAt` / `updatedAt` from `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type StorefrontDocument = Storefront & Document;

export const StorefrontSchema = SchemaFactory.createForClass(Storefront);

// An owner's own storefronts (the "your shops" list + per-owner allowance count).
StorefrontSchema.index({ ownerUserId: 1, createdAt: -1 });
// Unique public slug (per-collection namespace).
StorefrontSchema.index({ slug: 1 }, { unique: true });
// One storefront per company page (the attached store). Partial so the many
// unlinked storefronts (companyPageId null) are not forced unique. Integrity
// backstop; StorefrontService also enforces this on attach. Keep in sync with
// the company-page <-> storefront link (entities module + StorefrontService
// attach/unlink). Run the 2026-06-07 de-dup migration before this index builds.
StorefrontSchema.index(
  { companyPageId: 1 },
  { unique: true, partialFilterExpression: { companyPageId: { $type: 'objectId' } } },
);
