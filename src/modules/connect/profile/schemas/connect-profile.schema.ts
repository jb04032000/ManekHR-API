import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/**
 * ManekHR Connect — `ConnectProfile` collection.
 *
 * The layered Connect-specific identity, 1:1-keyed on `User._id` per
 * `docs/connect/IDENTITY-MODEL.md` ("one identity, layered data — connected,
 * never merged"). Shared identity fields (name, avatar, mobile) stay canonical
 * on the `User` schema and are *read* by Connect — they are deliberately NOT
 * duplicated here, because `User` is read by all 41 ERP modules and must stay
 * lean. Connect adds only its own banner + headline + the network/marketplace
 * data below.
 *
 * Lifecycle: created LAZILY on a user's first Connect onboarding — never
 * auto-created for every ERP user. Cascades on `User` delete (Phase 1 wires
 * the cascade hook + CRUD endpoints; Phase 0 is schema + wiring only).
 *
 * The ERP-linked badge is intentionally absent from this schema — it is
 * DERIVED live by `ErpLinkService`, never stored (design-decisions doc §9.1,
 * `IDENTITY-MODEL.md`).
 *
 * Every `@Prop` carries an explicit `{ type }` — required by `@nestjs/mongoose`
 * and by the repo's Vitest SWC transform (see `vitest.config.ts`) so that
 * `SchemaFactory.createForClass` resolves without `emitDecoratorMetadata`.
 */

/** `ConnectProfile.visibility` — controls public exposure at `/u/[userId]`. */
export const CONNECT_PROFILE_VISIBILITIES = ['public', 'connections', 'hidden'] as const;
export type ConnectProfileVisibility = (typeof CONNECT_PROFILE_VISIBILITIES)[number];

/**
 * `ConnectTrainingItem.confirmStatus`: the institute-confirmation lifecycle of a
 * self-declared credential (Institutes Phase 2).
 *  - `self`      the student typed it; no institute has weighed in (the default).
 *  - `pending`   the student asked the linked institute to confirm; awaiting it.
 *  - `confirmed` the institute owner confirmed it ("Confirmed by [Institute]").
 *  - `declined`  the institute owner declined to confirm it.
 * CRITICAL invariant: only the INSTITUTE-side write path (Feature 2/3) may move a
 * credential to `confirmed` / `declined`. The student PATCH DTO accepts only the
 * first two values (see `TrainingItemDto.confirmStatus` @IsIn), and the service
 * write-guard re-derives the stored status so a student can never forge a
 * confirmation. Keep in sync with the web confirm-badge renderer + the
 * `update-connect-profile.dto.ts` student-side @IsIn list.
 */
export const CONNECT_TRAINING_CONFIRM_STATUSES = [
  'self',
  'pending',
  'confirmed',
  'declined',
] as const;
export type ConnectTrainingConfirmStatus = (typeof CONNECT_TRAINING_CONFIRM_STATUSES)[number];

/**
 * `ConnectProfile.contactPreference` — the channel the person wants to be
 * reached on first. A display signal only: it never exposes the mobile
 * number, which stays canonical (and access-controlled) on `User`.
 */
export const CONNECT_CONTACT_PREFERENCES = ['whatsapp', 'phone', 'dm'] as const;
export type ConnectContactPreference = (typeof CONNECT_CONTACT_PREFERENCES)[number];

/** `ConnectProfile.onboardingIntent` — the persona picked at onboarding. */
export const CONNECT_ONBOARDING_INTENTS = [
  'workshop_owner',
  'karigar',
  'buyer',
  'explorer',
] as const;
export type ConnectOnboardingIntentValue = (typeof CONNECT_ONBOARDING_INTENTS)[number];

// ─── Sub-schemas (embedded; no own _id) ──────────────────────────────────────

/**
 * A single portfolio piece — a photo of the karigar's work, tagged with the
 * machine + work type so buyers / employers can filter by capability.
 */
@Schema({ _id: false })
export class ConnectPortfolioItem {
  /** Uploaded image URL (uploads `connect-portfolio` category — Phase 1). */
  @Prop({ type: String, required: true, trim: true })
  image: string;

  @Prop({ type: String, trim: true, maxlength: 280 })
  caption?: string;

  /** Embroidery machine the piece was produced on (e.g. "Multi-head", "Barudan"). */
  @Prop({ type: String, trim: true, maxlength: 80 })
  machineType?: string;

  /** Work type / technique (e.g. "zari", "sequins", "thread work"). */
  @Prop({ type: String, trim: true, maxlength: 80 })
  workType?: string;
}
export const ConnectPortfolioItemSchema = SchemaFactory.createForClass(ConnectPortfolioItem);

/**
 * A single service the member offers (freelancer / job-work layer). Free-typed,
 * static this phase (no search/taxonomy): a short title + an optional one-line
 * note. Mirrors `ConnectPortfolioItem` (a list of optional-field objects).
 */
@Schema({ _id: false })
export class ConnectServiceItem {
  /** Service name (e.g. "Digitizing", "Job-work"). */
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  title: string;

  /** Optional one-line note about the service. */
  @Prop({ type: String, trim: true, maxlength: 160 })
  note?: string;
}
export const ConnectServiceItemSchema = SchemaFactory.createForClass(ConnectServiceItem);

/**
 * One profile video — a single short intro / showreel clip. Mirrors the
 * marketplace `ListingVideo` shape (url + posterUrl + durationSec) so the SAME
 * upload pipeline drives both:
 *  - `url`        the uploaded clip (uploads `connect-profile-video` category).
 *  - `posterUrl`  an optional client-captured poster frame, uploaded as a normal
 *                 image; lets the web profile header paint a still with
 *                 `preload="metadata"` instead of a black box. Passes the SAME
 *                 media-ownership check as `url` (see ConnectProfileService).
 *  - `durationSec` the SERVER-parsed clip length (uploads probes it at upload
 *                 time); copied here at write time, never a client claim.
 *
 * The profile carries at most ONE video (DTO `@ArrayMaxSize(1)`); the field is an
 * array purely so a future "multiple videos" change needs no schema migration.
 */
@Schema({ _id: false })
export class ConnectProfileVideo {
  @Prop({ type: String, required: true, trim: true })
  url: string;

  @Prop({ type: String, trim: true })
  posterUrl?: string;

  @Prop({ type: Number, min: 0 })
  durationSec?: number;
}
export const ConnectProfileVideoSchema = SchemaFactory.createForClass(ConnectProfileVideo);

/** A past / current engagement at a workshop — the Connect work history. */
@Schema({ _id: false })
export class ConnectExperienceItem {
  /** Workshop / employer name (free text — not necessarily a ManekHR workspace). */
  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  workshop: string;

  /**
   * OPTIONAL link to a CompanyPage on the platform. `null`/absent = the company
   * is NOT on the platform (free-text only); `workshop` stays the display name +
   * fallback. Cross-module: resolved to {name,slug,logo} via CompanyPageService.getRefs
   * on the profile read; the web experience list renders the logo + /company/[slug] link.
   */
  @Prop({ type: Types.ObjectId, ref: 'CompanyPage', default: null })
  companyPageId?: Types.ObjectId | null;

  @Prop({ type: String, trim: true, maxlength: 120 })
  role?: string;

  @Prop({ type: Date })
  from?: Date;

  /** `null` / unset → currently working here. */
  @Prop({ type: Date, default: null })
  to?: Date | null;

  @Prop({ type: String, trim: true, maxlength: 1000 })
  description?: string;
}
export const ConnectExperienceItemSchema = SchemaFactory.createForClass(ConnectExperienceItem);

/**
 * A self-declared training / education credential. The student types it;
 * `companyPageId` optionally links the institute's CompanyPage (resolved to
 * name/logo/slug on the profile read, exactly like ConnectExperienceItem).
 *
 * Institutes Phase 2 layers institute-confirmation on top of the Phase 1
 * self-declaration: a linked institute owner can confirm the credential
 * ("Confirmed by [Institute]") via the institute-side write path, and the student
 * can opt this single credential in to the institute's public alumni / placement
 * surfaces (`shareWithInstitute`, default OFF for DPDP). The confirmation alone
 * is the badge (no GST / Udyam verification; that is Phase 3, out of scope).
 *
 * What does the FE render:
 *  - `confirmStatus` drives the badge: `confirmed` => "Confirmed by [Institute]".
 *  - `confirmedAt` / `confirmedByUserId` are the audit trail of WHO confirmed it
 *    and WHEN; `confirmedByUserId` is institute-internal and is NEVER exposed on
 *    the public profile read (see ConnectProfileService read projection).
 *
 * CRITICAL invariant: a STUDENT can never produce `confirmed` / `declined` nor
 * set `confirmedAt` / `confirmedByUserId`. The student DTO accepts only
 * `self` / `pending`, and `ConnectProfileService.update` re-derives the stored
 * status against the prior doc so an institute's decision is authoritative. Only
 * the institute-side write path (Feature 2/3) moves a credential to
 * `confirmed` / `declined`. `instituteName` is the required display name (and the
 * fallback when no page is linked / the page is not public).
 *
 * Cross-module links: `companyPageId` -> Connect entities CompanyPage (resolved
 * on the profile read); `confirmedByUserId` -> `User` (the institute member who
 * confirmed). The institute-side alumni / placement query (Feature 3) reads by
 * `{ companyPageId, confirmStatus }`. Keep the matching Schema.index() below.
 */
@Schema({ _id: false })
export class ConnectTrainingItem {
  /**
   * Stable per-credential id: a server-assigned ObjectId hex string. The subdoc
   * itself carries no own `_id` (`_id: false`); this `id` is the durable handle
   * that confirm / decline (Feature 2/3) AND the student edit-reconciliation in
   * `ConnectProfileService.update` match on, so a student re-ordering or editing
   * their list never detaches an institute's confirmation. Assigned by the
   * service for any incoming item without a known id (never trusted from a
   * student to mint a NEW confirmed credential; status is re-derived).
   */
  @Prop({ type: String, required: true })
  id: string;

  /** Institute / academy name (free text - the display name + link fallback). */
  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  instituteName: string;

  /**
   * OPTIONAL link to the institute's CompanyPage on the platform. `null`/absent =
   * the institute is NOT on the platform (free-text only); `instituteName` stays
   * the display name. Resolved to {name,slug,logo} via the profile read (mirrors
   * how ConnectExperienceItem.companyPageId resolves); a hidden/missing page is
   * dropped from the resolved map so it never leaks. Changing this link on a
   * prior-confirmed credential RESETS confirmStatus to `self` (the new institute
   * never confirmed it). Enforced in `ConnectProfileService.update`.
   */
  @Prop({ type: Types.ObjectId, ref: 'CompanyPage', default: null })
  companyPageId?: Types.ObjectId | null;

  /** Course / programme name, e.g. "Computerised Embroidery". */
  @Prop({ type: String, trim: true, maxlength: 160 })
  course?: string;

  /** When the student completed it. `null`/unset when ongoing / not stated. */
  @Prop({ type: Date, default: null })
  completedAt?: Date | null;

  /** Optional certificate file URL the student uploaded (display-only). */
  @Prop({ type: String, trim: true, maxlength: 2048 })
  certificateUrl?: string;

  /**
   * Institute-confirmation status (Institutes Phase 2). Defaults to `self` so
   * every legacy Phase 1 credential reads as self-declared with no migration.
   * Only the institute-side write path sets `confirmed` / `declined`; the student
   * path is capped at `self` / `pending` by the DTO + the service write-guard.
   */
  @Prop({ type: String, enum: CONNECT_TRAINING_CONFIRM_STATUSES, default: 'self' })
  confirmStatus: ConnectTrainingConfirmStatus;

  /**
   * When the institute confirmed (or declined) the credential. `null` until an
   * institute acts. Never student-writable (absent from the student DTO; the
   * service clears it to null on any student-side status reset).
   */
  @Prop({ type: Date, default: null })
  confirmedAt?: Date | null;

  /**
   * The `User` (an institute member) who confirmed the credential. `null` until
   * confirmed. Institute-internal audit trail. NEVER exposed on the public
   * profile read (the read projection omits it). Never student-writable.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  confirmedByUserId?: Types.ObjectId | null;

  /**
   * Per-credential student opt-in to appear on the linked institute's public
   * alumni / placement surfaces (DPDP, default OFF). The student controls this
   * for their OWN credential; it is independent of the confirmation status. The
   * institute-side public alumni query (Feature 3) filters on this being true.
   */
  @Prop({ type: Boolean, default: false })
  shareWithInstitute: boolean;
}
export const ConnectTrainingItemSchema = SchemaFactory.createForClass(ConnectTrainingItem);

/** A recommendation written by another Connect user. */
@Schema({ _id: false })
export class ConnectRecommendation {
  /** The `User` who wrote the recommendation. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  fromUserId: User | Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 1000 })
  text: string;

  @Prop({ type: Date, default: () => new Date() })
  createdAt: Date;
}
export const ConnectRecommendationSchema = SchemaFactory.createForClass(ConnectRecommendation);

/**
 * Rate card — every field optional; a karigar may quote on any combination of
 * a daily wage, a per-piece rate, or a monthly salary. Amounts are stored in
 * paise (whole integers) to match the ERP-wide money convention (`*Paise`
 * fields across finance/salary) and avoid floating-point drift.
 */
@Schema({ _id: false })
export class ConnectRateCard {
  /** Daily wage, in paise. */
  @Prop({ type: Number, min: 0 })
  dailyWage?: number;

  /** Per-piece rate, in paise. */
  @Prop({ type: Number, min: 0 })
  pieceRate?: number;

  /** Monthly salary expectation, in paise. */
  @Prop({ type: Number, min: 0 })
  monthly?: number;
}
export const ConnectRateCardSchema = SchemaFactory.createForClass(ConnectRateCard);

/** Audience for a rich "open to" card. `all` = anyone; `network` = first-degree only. */
export const CONNECT_OPEN_TO_AUDIENCES = ['all', 'network'] as const;
export type ConnectOpenToAudience = (typeof CONNECT_OPEN_TO_AUDIENCES)[number];

/**
 * Rich detail for one "open to" intent. ADDITIVE companion to the `openTo`
 * booleans (which stay the on/off gate read by search + feed ranking). The
 * boolean turns the card on; this carries the card's blurb + who may see it.
 * Keep in sync with web `ConnectOpenToDetail` + the profile intent cards.
 */
@Schema({ _id: false })
export class ConnectOpenToDetail {
  @Prop({ type: String, trim: true, maxlength: 160 })
  detail?: string;

  @Prop({ type: String, enum: CONNECT_OPEN_TO_AUDIENCES, default: 'all' })
  audience: ConnectOpenToAudience;
}
export const ConnectOpenToDetailSchema = SchemaFactory.createForClass(ConnectOpenToDetail);

/** Per-intent rich details, keyed to the four `openTo` booleans. */
@Schema({ _id: false })
export class ConnectOpenToDetails {
  @Prop({ type: ConnectOpenToDetailSchema }) work?: ConnectOpenToDetail;
  @Prop({ type: ConnectOpenToDetailSchema }) hiring?: ConnectOpenToDetail;
  @Prop({ type: ConnectOpenToDetailSchema }) deals?: ConnectOpenToDetail;
  @Prop({ type: ConnectOpenToDetailSchema }) customOrders?: ConnectOpenToDetail;
}
export const ConnectOpenToDetailsSchema = SchemaFactory.createForClass(ConnectOpenToDetails);

/**
 * "Open to" status toggles — user-controlled. Drive the Tier-3 status badges
 * (design-decisions doc §3.1: "Open to work / hiring / deals / custom orders").
 */
@Schema({ _id: false })
export class ConnectOpenTo {
  /** Open to work — looking for a job / karigar engagement. */
  @Prop({ type: Boolean, default: false })
  work: boolean;

  /** Open to hiring — looking to hire karigars. */
  @Prop({ type: Boolean, default: false })
  hiring: boolean;

  /** Open to deals — open to marketplace buying / selling. */
  @Prop({ type: Boolean, default: false })
  deals: boolean;

  /** Open to custom orders — accepts bespoke / made-to-order work. */
  @Prop({ type: Boolean, default: false })
  customOrders: boolean;
}
export const ConnectOpenToSchema = SchemaFactory.createForClass(ConnectOpenTo);

// ─── ConnectProfile document ─────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'connectprofiles' })
export class ConnectProfile extends Document {
  /**
   * The owning `User`. 1:1 — exactly one `ConnectProfile` per `User`. The
   * unique index is declared once via `schema.index()` below (not also here)
   * so Mongoose does not warn about a duplicate index definition.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: User | Types.ObjectId;

  /** Short professional headline (e.g. "Zari karigar · 12 yrs · Multi-head"). */
  @Prop({ type: String, trim: true, maxlength: 160, default: '' })
  headline: string;

  /** Long-form about / bio. */
  @Prop({ type: String, trim: true, maxlength: 2000, default: '' })
  bio: string;

  /** Connect-only cover image URL. The avatar stays canonical on `User`. */
  @Prop({ type: String, trim: true, default: '' })
  banner: string;

  /** Embroidery skill taxonomy tags (e.g. "zari", "sequins", "aari"). */
  @Prop({ type: [String], default: [] })
  skills: string[];

  /**
   * Home district / textile hub (e.g. "Surat", "Jetpur"). Powers GeoLocal feed
   * discovery (posts from the viewer's locality). Free-text, trimmed; matched
   * case-insensitively. Empty until the member sets it.
   */
  @Prop({ type: String, trim: true, maxlength: 80, default: '' })
  district: string;

  /**
   * Structured canonical location (ADDITIVE). The free-text `district` above
   * stays source-of-truth until the backfill migration runs; these are slugs
   * from the shared india-geo dataset (modules/connect/geo/india-geo) plus an
   * optional free-text city. Kept FLAT (not nested) as a minimal additive change.
   * Empty until the member picks a State -> District in profile-edit/onboarding.
   *
   * No dedicated index on geoDistrictSlug: boost region targeting matches on the
   * free-text `district` NAME (see ad-profile.source.ts AdProfile build +
   * ConnectAudienceCounter), and the per-viewer profile build loads by `userId`
   * (the unique userId index). So a geoDistrictSlug index would help no targeting
   * query — left out deliberately (no gratuitous index). The backfill migration
   * 0045 fills these from a recognizable free-text `district`.
   */
  @Prop({ type: String, trim: true, maxlength: 60, default: '' })
  geoStateSlug: string;

  @Prop({ type: String, trim: true, maxlength: 80, default: '' })
  geoDistrictSlug: string;

  @Prop({ type: String, trim: true, maxlength: 80, default: '' })
  geoCity: string;

  /** Showcase of work samples. */
  @Prop({ type: [ConnectPortfolioItemSchema], default: [] })
  portfolio: ConnectPortfolioItem[];

  /**
   * Profile intro video (at most one - the DTO caps the array at 1). ADDITIVE to
   * `banner` / `portfolio`: the avatar + cover still come from `User` + `banner`;
   * the video is a bonus showreel shown in the web profile header (no card/badge
   * surface). Each entry's `durationSec` is server-derived (see
   * ConnectProfileService.buildOwnedVideos). Empty by default, so every pre-video
   * profile is unchanged - no migration.
   */
  @Prop({ type: [ConnectProfileVideoSchema], default: [] })
  videos: ConnectProfileVideo[];

  /** Work history across workshops. */
  @Prop({ type: [ConnectExperienceItemSchema], default: [] })
  experience: ConnectExperienceItem[];

  /**
   * Self-declared training / education credentials (Institutes Phase 1). Each
   * entry optionally links the institute's CompanyPage (resolved on the profile
   * read, like experience). Additive - empty [] for every legacy profile, no
   * migration. SELF-DECLARED only this phase: no verified flag (Phase 2).
   */
  @Prop({ type: [ConnectTrainingItemSchema], default: [] })
  training: ConnectTrainingItem[];

  /** Services the member offers (freelancer / job-work layer). Free-typed, static
   *  this phase (no search/taxonomy). Each: a short title + optional one-line note.
   *  Cross-module: shown in the web profile Services section + edited via the
   *  per-section modal. Additive - empty [] for legacy docs, no migration. */
  @Prop({ type: [ConnectServiceItemSchema], default: [] })
  services: ConnectServiceItem[];

  /** Peer recommendations. */
  @Prop({ type: [ConnectRecommendationSchema], default: [] })
  recommendations: ConnectRecommendation[];

  /** Quoted rates. Always present (defaulted) so the FE can render the card. */
  @Prop({
    type: ConnectRateCardSchema,
    default: () => ({}),
  })
  rateCard: ConnectRateCard;

  /** Status toggles powering the Tier-3 "Open to …" badges. */
  @Prop({
    type: ConnectOpenToSchema,
    default: () => ({
      work: false,
      hiring: false,
      deals: false,
      customOrders: false,
    }),
  })
  openTo: ConnectOpenTo;

  /**
   * ADDITIVE rich data for the "open to" cards (detail + audience per intent).
   * The `openTo` booleans above stay the gate; this is empty `{}` for every
   * legacy document, so no migration is needed. Read by the profile intent cards.
   */
  @Prop({ type: ConnectOpenToDetailsSchema, default: () => ({}) })
  openToDetails: ConnectOpenToDetails;

  /**
   * Broker / dalal self-declaration (Broker badge, Slice 1). A self-declared
   * flag, like the `openTo` booleans: the user turns it on in profile-edit to
   * say "I introduce buyers and sellers". Additive — `false` for every legacy
   * profile, so no migration. Drives the "Broker" trust badge on the profile +
   * entity cards. Mirrors the additive-boolean style of the `openTo` toggles.
   */
  @Prop({ type: Boolean, default: false })
  isBroker: boolean;

  /**
   * When the user first marked themselves a broker. Stamped ONCE by the service
   * on the false→true flip (never overwritten, never cleared on toggle-off), so
   * a "broker since" track record is preserved. `null` until first enabled.
   * Not student-/client-writable: the service sets it, not the PATCH body.
   */
  @Prop({ type: Date, default: null })
  brokerSince?: Date | null;

  /**
   * Preferred first-contact channel — surfaced on the profile header via
   * `ContactPreferenceSelector`. `whatsapp` is the default: the audience is
   * WhatsApp-first (design-decisions doc §4.1). This is a display preference
   * only — it does NOT expose the mobile number, which stays canonical (and
   * access-controlled) on `User` (privacy wall).
   */
  @Prop({
    type: String,
    enum: CONNECT_CONTACT_PREFERENCES,
    default: 'whatsapp',
  })
  contactPreference: ConnectContactPreference;

  /**
   * Public-exposure level. `public` → reachable + indexable at `/u/[userId]`;
   * `connections` / `hidden` → restricted view or 404 for non-authorized
   * viewers (`IDENTITY-MODEL.md` "Public exposure"). Default `public` — a user
   * who completes onboarding wants to be found; they can dial it down.
   */
  @Prop({
    type: String,
    enum: CONNECT_PROFILE_VISIBILITIES,
    default: 'public',
    index: true,
  })
  visibility: ConnectProfileVisibility;

  /**
   * The visibility this profile had BEFORE a reversible Scope-1 "delete Connect"
   * hid it (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3A soft phase). Stamped once when
   * `hideForConnectDeletion` flips `visibility` to `hidden`, so admin-mediated
   * recovery can restore the EXACT prior level (a previously `connections`-only
   * profile must not come back as `public`). `null`/absent for every normal
   * profile, so no migration. Cleared on recovery (`unhideForConnectRecovery`).
   */
  @Prop({ type: String, enum: CONNECT_PROFILE_VISIBILITIES, default: null })
  preDeletionVisibility?: ConnectProfileVisibility | null;

  /**
   * Computed profile-completeness percentage (0–100). Recomputed on every
   * profile write in Phase 1; Phase 0 ships the field with a `0` default.
   */
  @Prop({ type: Number, min: 0, max: 100, default: 0 })
  strength: number;

  /**
   * When the user completed the Connect onboarding intent flow. `null` until
   * then — `/connect` smart-entry routes a not-yet-onboarded user to the
   * onboarding screen. Stamped once by `completeOnboarding`, never cleared.
   */
  @Prop({ type: Date, default: null })
  onboardedAt?: Date | null;

  /**
   * The persona the user picked in the onboarding intent flow. Persisted so
   * downstream surfaces (the Connect→ERP cross-sell) can read it. `null` until
   * the user completes onboarding.
   */
  @Prop({ type: String, enum: CONNECT_ONBOARDING_INTENTS, default: null })
  onboardingIntent?: ConnectOnboardingIntentValue | null;

  /**
   * ERP-linked verification consent (consent-first verification, ADR-0004 /
   * 2026-06-18 spec). The ERP-linked PROFILE badge is now CONSENT-GATED: no ERP
   * activity is read and no badge is shown until the subject explicitly opts in
   * here. `ErpLinkService.getUserStatus` returns `{ linked: false }` unless
   * `status === 'granted'`. `null` / absent = never asked (no badge) — the
   * default for every legacy profile, so no migration is needed.
   *
   *  - `status`         'granted' (badge eligible) | 'revoked' (badge off, we
   *                     stop reading). Absent = never consented.
   *  - `grantedAt`      when consent was given; `null` once revoked.
   *  - `revokedAt`      when consent was withdrawn; `null` while granted.
   *  - `consentVersion` the consent text version the user agreed to
   *                     (`erp-verify-v1`). A future version bump re-prompts.
   *
   * Written ONLY by `ErpVerificationService` (grant / revoke), cleared on
   * account erasure (`handleAccountErased`). Sub-doc has no own `_id`.
   */
  @Prop({
    type: {
      status: { type: String },
      grantedAt: { type: Date },
      revokedAt: { type: Date },
      consentVersion: { type: String },
    },
    default: null,
    _id: false,
  })
  erpVerificationConsent?: {
    status: 'granted' | 'revoked';
    grantedAt: Date | null;
    revokedAt: Date | null;
    consentVersion: string;
  } | null;

  /**
   * When the user dismissed the one-time "verify with your ERP" suggestion
   * banner ("Not now"). `null` = never dismissed (the banner is eligible to
   * show). Lets the suggestion banner avoid nagging; a long interval / consent-
   * version bump re-arms it. Set by `ErpVerificationService.dismissSuggestion`.
   */
  @Prop({ type: Date, default: null })
  erpSuggestionDismissedAt?: Date | null;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ConnectProfileSchema = SchemaFactory.createForClass(ConnectProfile);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// 1:1 with User — also the primary lookup (`getProfileByUserId`). Declared
// here as well as on the @Prop so the intent is explicit and survives a future
// @Prop refactor. Mongoose de-duplicates identical index specs.
ConnectProfileSchema.index({ userId: 1 }, { unique: true });

// Public-directory / SEO scans (Phase 1 `/u/[id]`, Phase 2 people search
// bootstrap) list public profiles newest-first.
ConnectProfileSchema.index({ visibility: 1, updatedAt: -1 });

// Institute-side alumni / placement query (Institutes Phase 2, Feature 3):
// "all credentials linked to THIS institute's CompanyPage with a given confirm
// status" (e.g. pending-to-review queue, confirmed alumni list). Multikey index
// over the embedded `training[]` sub-documents. NOTE: building this index on an
// already-large `connectprofiles` collection in production must go through the
// migration ledger (`npm run migrate`), NOT an onModuleInit / boot-time build,
// per the migration-ledger convention. Declared here so a fresh DB + the schema
// test build it; on an existing DB the ledger owns the rollout. Keep in sync
// with the institute-side query in the Feature 3 service.
ConnectProfileSchema.index({ 'training.companyPageId': 1, 'training.confirmStatus': 1 });
