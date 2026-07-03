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
 * ManekHR Connect -- `CompanyPage` (Phase 6 entity, built on the Phase 4
 * foundation). A business's public IDENTITY page: who they are, what they make,
 * their capacity. Optional (a user may have 0, 1, or many) and independent of
 * any Storefront. Public URL `/company/[slug]`, admin `/connect/page/[slug]/manage`.
 *
 * Person-centric: owned by exactly one `User` (`ownerUserId`), never a
 * workspace. The ERP-linked badge is DERIVED from `erpWorkspaceId` via
 * `ErpLinkService` at read time, never stored.
 *
 * Posts / followers / jobs are LATER phases -- this schema leaves clean seams
 * (no fields for them yet).
 */

/**
 * `CompanyPage.kind` -- whether the page is an ordinary business / workshop
 * (the default, what every page was before this field existed) or a training
 * institute / academy. Additive: a `default: 'business'` on the @Prop means
 * every pre-existing document reads back as a business with no migration, and
 * an institute is just a business page with `kind: 'institute'` plus the
 * optional `institutePanel` below. Institutes reuse the entire page pipeline
 * (slug, logo, banner, about, posts, jobs, location, ERP link).
 */
export const COMPANY_PAGE_KINDS = ['business', 'institute'] as const;
export type CompanyPageKind = (typeof COMPANY_PAGE_KINDS)[number];

/**
 * `CompanyInstitutePanel.modes` -- how an institute delivers its training.
 * Parallel to (but separate from) the listing course `mode` enum, which also
 * carries `hybrid`; an institute lists the modes it offers across all courses.
 */
export const COMPANY_INSTITUTE_MODES = ['online', 'offline'] as const;
export type CompanyInstituteMode = (typeof COMPANY_INSTITUTE_MODES)[number];

/**
 * The institute "what we teach" panel -- the training-provider parallel to
 * `CompanyIndustryPanel`. Present only on `kind: 'institute'` pages; all fields
 * optional (an early institute may fill none). `coursesOffered` is a free-tag
 * list of course names (not the marketplace listing enum); `modes` is the
 * delivery mix; `languages` mirrors the industry panel's languages shape.
 */
@Schema({ _id: false })
export class CompanyInstitutePanel {
  /** Free-tag course names, e.g. ['Computerised Embroidery', 'Saree Draping']. */
  @Prop({ type: [String], default: [] })
  coursesOffered: string[];

  /** Delivery modes the institute offers (online and/or offline). */
  @Prop({ type: [String], enum: COMPANY_INSTITUTE_MODES, default: [] })
  modes: CompanyInstituteMode[];

  /** Languages courses are taught in, e.g. ['gu', 'hi', 'en']. */
  @Prop({ type: [String], default: [] })
  languages: string[];
}
export const CompanyInstitutePanelSchema = SchemaFactory.createForClass(CompanyInstitutePanel);

/**
 * The "what we do" panel on a company page. All optional; an early-stage
 * workshop may fill none. `specialization` / `languages` are free tags.
 */
@Schema({ _id: false })
export class CompanyIndustryPanel {
  /** e.g. ['embroidery-zari', 'job-work'] -- free tags, not the listing enum. */
  @Prop({ type: [String], default: [] })
  specialization: string[];

  /** Free-text machine / loom capacity, e.g. "12 power looms, 3 embroidery machines". */
  @Prop({ type: String, trim: true, maxlength: 500, default: '' })
  machineCapacity: string;

  /** Free-text production capacity, e.g. "5000 metres / week". */
  @Prop({ type: String, trim: true, maxlength: 500, default: '' })
  production: string;

  /** Languages the business communicates in, e.g. ['gu', 'hi', 'en']. */
  @Prop({ type: [String], default: [] })
  languages: string[];
}
export const CompanyIndustryPanelSchema = SchemaFactory.createForClass(CompanyIndustryPanel);

/**
 * One intro / teaser video on a company page. SAME shape + upload pipeline as the
 * marketplace `ListingVideo` (the canonical pattern this copies) -- the feed
 * `PostMedia` video shape (url + posterUrl + durationSec):
 *  - `url`        the uploaded clip (uploads `connect-company-video` category;
 *                 50MB, VIDEO_MIME, server-probed duration capped at 60s, public).
 *  - `posterUrl`  an optional client-captured poster frame, uploaded as a normal
 *                 image; lets the page paint a still instead of a black box. Passes
 *                 the SAME media-ownership check as `url` (see CompanyPageService).
 *  - `durationSec` the SERVER-parsed clip length (uploads probes it at upload
 *                 time); stamped here at write time, never a client claim.
 *
 * The page carries at most ONE video (DTO `@ArrayMaxSize(1)`); the field is an
 * array purely so a future "multiple videos" change needs no schema migration.
 * The 60s length cap lives in the uploads media-probe, not this schema.
 */
@Schema({ _id: false })
export class CompanyPageVideo {
  @Prop({ type: String, required: true, trim: true })
  url: string;

  @Prop({ type: String, trim: true })
  posterUrl?: string;

  @Prop({ type: Number, min: 0 })
  durationSec?: number;
}
export const CompanyPageVideoSchema = SchemaFactory.createForClass(CompanyPageVideo);

@Schema({ timestamps: true, collection: 'connect_company_pages' })
export class CompanyPage extends Document {
  /** The `User` who owns + admins this page. Person-centric -- never a workspace. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerUserId: User | Types.ObjectId;

  /** Unique URL slug -- the public page is `/company/[slug]`. */
  @Prop({ type: String, required: true, trim: true, lowercase: true, maxlength: 80 })
  slug: string;

  /** Business display name. */
  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  name: string;

  /**
   * Whether this page is an ordinary business / workshop (default) or a training
   * institute / academy. Additive: every pre-existing page defaults to
   * `business`, so nothing changes for existing documents. An institute fills
   * the optional `institutePanel` below and is surfaced via the `kind=institute`
   * directory filter / facet.
   */
  @Prop({ type: String, enum: COMPANY_PAGE_KINDS, default: 'business' })
  kind: CompanyPageKind;

  /** Logo image URL (uploads `connect-*` category). */
  @Prop({ type: String, trim: true, default: '' })
  logo: string;

  /** Banner image URL. */
  @Prop({ type: String, trim: true, default: '' })
  banner: string;

  /**
   * Intro / teaser video (at most one - the DTO caps the array at 1). ADDITIVE to
   * logo/banner: identity + directory still come from name/logo/banner; the video
   * is a bonus shown on the page + flagged with a play badge on directory cards
   * (browse `hasVideo`). Each entry's `durationSec` is server-derived (see
   * CompanyPageService.buildOwnedVideos). Empty by default, so every pre-video
   * page is unchanged. Mirrors the marketplace `Listing.videos` field exactly.
   */
  @Prop({ type: [CompanyPageVideoSchema], default: [] })
  videos: CompanyPageVideo[];

  /** About / story prose. */
  @Prop({ type: String, trim: true, maxlength: 5000, default: '' })
  about: string;

  /** The "what we do / capacity" panel. */
  @Prop({ type: CompanyIndustryPanelSchema, default: () => ({}) })
  industryPanel: CompanyIndustryPanel;

  /**
   * The institute "what we teach" panel. Defaulted (empty) so every page has the
   * shape, but only meaningful on `kind: 'institute'` pages; a business page
   * leaves it empty. Additive, no migration.
   */
  @Prop({ type: CompanyInstitutePanelSchema, default: () => ({}) })
  institutePanel: CompanyInstitutePanel;

  /** Where the business is based -- powers geo discovery + filters. */
  @Prop({ type: EntityLocationSchema, default: () => ({}) })
  location: EntityLocation;

  /**
   * OPTIONAL ERP link. When set, the ERP-linked badge is DERIVED from this
   * workspace's activity via `ErpLinkService` (never stored). `null` = no link.
   *
   * As of the consent-first verification work (ADR-0004 / 2026-06-18 spec) this
   * pointer is set ONLY through the ownership-checked link path
   * (`CompanyPageService.linkErpWorkspace`, which verifies the caller owns the
   * workspace) — the create/update DTOs no longer accept it raw. The companion
   * `erpLink` sub-doc below carries the link's consent record; this stays the
   * read field the derivation + the directory `erpVerified` filter use.
   */
  @Prop({ type: Types.ObjectId, ref: 'Workspace', default: null })
  erpWorkspaceId?: Types.ObjectId | null;

  /**
   * ERP-link consent + ownership record (consent-first verification). Set
   * alongside `erpWorkspaceId` by `linkErpWorkspace` AFTER an `isWorkspaceOwner`
   * check; cleared (`status: 'revoked'`, `erpWorkspaceId: null`) on owner unlink,
   * entity delete, account erasure, or the `workspace.deleted` cascade. Reads
   * count ERP activity ONLY when `status === 'verified'`. `null` = never linked
   * (no badge) — the default for every legacy page, so no migration is needed.
   *
   *  - `status`         'verified' (badge eligible) | 'revoked' (badge off).
   *  - `linkedByUserId` the workspace owner who linked it (audit trail).
   *  - `linkedAt`       when the link was made; `null` once revoked.
   *  - `consentVersion` the consent text version (`erp-verify-v1`).
   *
   * Sub-doc has no own `_id`. Identical shape on `Storefront.erpLink`.
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

  // `createdAt` / `updatedAt` from `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type CompanyPageDocument = CompanyPage & Document;

export const CompanyPageSchema = SchemaFactory.createForClass(CompanyPage);

// An owner's own company pages (the "your pages" list + per-owner allowance count).
CompanyPageSchema.index({ ownerUserId: 1, createdAt: -1 });
// Unique public slug (per-collection namespace; `/company` and `/store` URLs differ).
CompanyPageSchema.index({ slug: 1 }, { unique: true });
// Public directory browse filtered by kind (the "Institutes" facet) + recency.
CompanyPageSchema.index({ kind: 1, visibility: 1, createdAt: -1 });
