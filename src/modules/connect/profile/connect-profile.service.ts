import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
// Auth fires ACCOUNT_ERASED on admin erasure / ban; this module listens to hide
// + de-index the user from public Connect surfaces (OQ-3). Importing only the
// event constant + type keeps auth a one-way dependency (no module cycle).
import { ACCOUNT_ERASED, type AccountErasedEvent } from '../../auth/events/account-erasure.events';
// CN-MOD-1 (feed harden Bucket 6): the profile module owns the takedown reaction
// for `targetType:'profile'` (shared abstraction #3 — same dispatch pattern as
// feed/listing/comment). Imported by name + type only, so no static dep on the
// content-reports service (it stays a leaf module = no cycle).
import {
  CONTENT_TAKEDOWN_EVENT,
  type ContentTakedownEvent,
} from '../content-reports/content-reports.constants';
import {
  ConnectProfile,
  ConnectOpenTo,
  type ConnectTrainingConfirmStatus,
  type ConnectProfileVisibility,
} from './schemas/connect-profile.schema';
import { ConnectAllowanceService } from '../monetization/connect-allowance.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { ReviewService, type RatingAggregate } from '../reviews/review.service';
import { User } from '../../users/schemas/user.schema';
import { Connection } from '../network/schemas/connection.schema';
import { CompanyPage } from '../entities/schemas/company-page.schema';
import { Storefront } from '../entities/schemas/storefront.schema';
import { MediaOwnershipService } from '../../uploads/services/media-ownership.service';
import type { UpdateConnectProfileDto } from './dto/update-connect-profile.dto';
import type { ConnectOnboardingIntent } from './dto/complete-onboarding.dto';
import {
  CONNECT_PROFILE_CHANGED,
  type ConnectProfileChangedEvent,
} from './events/connect-profile.events';
import {
  CONNECT_PROFILE_CREATED,
  type ConnectProfileCreatedEvent,
} from './events/connect-profile-created.events';
import {
  buildPage,
  clampPageSize,
  decodeCursor,
  keysetFilter,
  LIST_HARD_CAP,
} from '../common/keyset-cursor';

/** Profile-strength weights — see docs/connect/phases/phase-1-identity.md. Sum = 100. */
const STRENGTH_WEIGHTS = {
  headline: 15,
  bio: 15,
  banner: 10,
  skills: 20, // ≥ 3 skills
  portfolio: 20, // ≥ 1 item
  experience: 10, // ≥ 1 entry
  rateCard: 10, // any rate set
} as const;

/** The mutable fields a profile owner may PATCH (recommendations excluded). */
const UPDATABLE_FIELDS = [
  'headline',
  'bio',
  'banner',
  'skills',
  'district',
  'geoStateSlug',
  'geoDistrictSlug',
  'geoCity',
  'portfolio',
  'experience',
  'training',
  'services',
  'rateCard',
  'openTo',
  'openToDetails',
  'visibility',
  'contactPreference',
  'isBroker',
] as const;

/**
 * Viewer-facing identity for a people card — used by the network /
 * suggestions / search surfaces to render a `PersonCard` without an N+1.
 * `name` + `avatar` are canonical on `User`; `headline` is the person's
 * `ConnectProfile` one-liner (null when they have no profile).
 */
export interface ConnectPersonRef {
  userId: string;
  name: string;
  avatar: string | null;
  headline: string | null;
  /**
   * Derived traveling "open to" status for the avatar ring on broad person
   * cards (search / suggestions / connections). `null` when the person is not
   * broadcasting, or only broadcasting to a `network`-scoped audience (see
   * `deriveOpenStatus`).
   */
  openStatus: ConnectOpenStatus;
  /**
   * True for seeded demo / sample accounts (User.isDemo). Lets every people card
   * (suggestions / network / search / post-author) render a "Sample" tag and the
   * suggestion ranker down-rank demo. Reads the same User.isDemo as the admin demo
   * manager + sitemap exclusion. See DEMO-CONTENT-TRUST-UX-PLAN.md.
   */
  isDemo: boolean;
}

export type ConnectOpenStatus = 'work' | 'hiring' | null;

/**
 * Minimal linked-CompanyPage identity attached to a profile read so the web
 * experience list can render a logo + `/company/[slug]` link in one round-trip.
 * Shape is IDENTICAL to `CompanyPageService.CompanyPageRef` (id,name,slug,logo,
 * erpLinked) - defined locally rather than imported to avoid a circular module
 * import: `ConnectEntitiesModule` already imports `ConnectProfileModule` (for
 * `ErpLinkService`), so importing the entities service back here would cycle.
 * We read the `CompanyPage` model directly instead (see `companyRefs`).
 */
export interface CompanyPageRef {
  id: string;
  name: string;
  slug: string;
  logo: string;
  erpLinked: boolean;
}

/**
 * The shape a training credential carries AFTER the student write-guard
 * (Institutes Phase 2): incoming from the DTO or already stored on the doc.
 * `id` + the confirm-* fields may be absent on a brand-new incoming item or a
 * legacy Phase 1 stored doc; `reconcileTraining` normalises them. Kept local to
 * the service: the persisted schema is `ConnectTrainingItem`; this is the
 * read/merge view used only by the reconciliation. Cross-module: confirm-* are
 * written only by the institute-side path (Feature 2/3), never the student PATCH.
 */
interface StoredTrainingItem {
  id?: string;
  instituteName?: string;
  companyPageId?: unknown;
  course?: string;
  completedAt?: Date | string | null;
  certificateUrl?: string;
  confirmStatus?: ConnectTrainingConfirmStatus;
  confirmedAt?: Date | null;
  confirmedByUserId?: Types.ObjectId | null;
  shareWithInstitute?: boolean;
}

/**
 * The training credential as it arrives from the student DTO. `confirmStatus` is
 * a plain `string` here (the DTO @IsIn-validates it to `self` / `pending` only);
 * `reconcileTraining` narrows it via an explicit `=== 'pending'` check and never
 * trusts it for `confirmed` / `declined`. `id` is round-tripped by the client so
 * an edit reconciles to the prior stored credential. Carries NO confirm metadata
 * (`confirmedAt` / `confirmedByUserId` are absent from the student DTO).
 */
interface IncomingTrainingItem {
  id?: string;
  instituteName?: string;
  companyPageId?: unknown;
  course?: string;
  completedAt?: Date | string | null;
  certificateUrl?: string;
  confirmStatus?: string;
  shareWithInstitute?: boolean;
}

/**
 * Institute-side dependency seams (Institutes Phase 2, Feature 2). These are
 * injected at runtime by the LEAF `ConnectInstitutesModule` via
 * `setInstituteDeps`, NOT through the constructor: `ConnectProfileService` must
 * stay free of any static import from `ConnectEntitiesModule`
 * (`CompanyPageService`) or the notifications module, because both already
 * depend (transitively) on the profile module, so a constructor dependency would
 * create a circular module import. The institutes module sits ABOVE both and is
 * the only place that can wire the page-admin gate + audit/analytics/bell into
 * this service. Cross-module: `companyPages.getMine` is the page-owner 404-gate
 * (entities); `notifications.dispatch` is the student bell (notifications); audit
 * + posthog are the @Global write seams. All optional so the service still works
 * for the student read/write paths when the institutes module is absent.
 */
interface InstituteCompanyGate {
  /** Load a CompanyPage the caller owns, or throw 404 (no existence leak). */
  getMine(ownerUserId: string, pageId: string): Promise<{ _id: unknown; ownerUserId: unknown }>;
}
interface InstituteAuditSeam {
  logEvent(input: {
    module: AppModule;
    entityType: string;
    entityId: string;
    action: string;
    actorId: string;
    meta?: Record<string, unknown>;
  }): Promise<unknown>;
}
interface InstitutePosthogSeam {
  capture(input: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
}
interface InstituteNotificationsSeam {
  dispatch(input: {
    recipientId: Types.ObjectId | string;
    category: string;
    title: string;
    message: string;
    actorId?: Types.ObjectId | string | null;
    entityType?: string | null;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

/** The bundle the institutes module wires into the profile service. */
export interface InstituteDeps {
  companyPages: InstituteCompanyGate;
  audit: InstituteAuditSeam;
  posthog?: InstitutePosthogSeam;
  notifications?: InstituteNotificationsSeam;
}

/** The student identity shown on one pending-credential row. Name + avatar are
 *  canonical on `User`; handle is the public slug. */
export interface CredentialStudentRef {
  userId: string;
  name: string;
  avatar: string | null;
  handle: string | null;
}

/** One pending-credential request the institute owner can confirm / decline. */
export interface PendingCredentialRequest {
  student: CredentialStudentRef;
  /** The matching training entry (institute-internal confirmedByUserId stripped). */
  training: Record<string, unknown>;
  /** The linked CompanyPage ref (this institute's page). Null if it went hidden. */
  company: CompanyPageRef | null;
}

// ─── Institutes Phase 2, Feature 3: institute-page PUBLIC reads ───────────────

/**
 * One alumnus card on the institute public Alumni / Open-to-work tab (Feature 3).
 * ConnectPerson-shaped (reuses the network people-card identity so the web renders
 * an existing `PersonCard`): `name` + `avatarUrl` are canonical on `User`,
 * `headline` is the person's ConnectProfile one-liner. `openStatus` is fixed to
 * `'work'` here (the tab only lists open-to-work alumni). `degree` is an OPTIONAL
 * viewer-relative connection degree the public controller may fold in (absent on
 * the logged-out read). DPDP: only opted-in (`shareWithInstitute === true`),
 * public, open-to-work alumni of THIS institute appear. Keep the field names in
 * sync with the web institute Alumni tab card.
 */
export interface InstituteAlumnus {
  userId: string;
  name: string;
  headline: string | null;
  avatarUrl: string | null;
  openStatus: 'work';
  degree?: number;
}

/** A page of institute alumni, cursor-paginated newest-first. The explicit empty
 *  marker (`items: []`, `total: 0`, `nextCursor: null`) lets the web render the
 *  invite CTA when an institute has no opted-in alumni yet. */
export interface InstituteAlumniResult {
  items: InstituteAlumnus[];
  /** Count of matching alumni in THIS page window (the over-fetch is trimmed). */
  total: number;
  /** Opaque keyset cursor for the next page, or `null` when the window was the last. */
  nextCursor: string | null;
}

/**
 * One employer row on the institute Placement wall ("where our students work",
 * Feature 3). `company` is a CompanyPage browse-card-ish ref (id/name/slug/logo/
 * erpLinked) resolved from a CONFIRMED, opted-in, public student's CURRENT
 * experience entry (the documented `experience.to == null` "currently working
 * here" signal). DERIVED, display-only, self-declared - NOT a verified placement.
 * Shape is a subset of `CompanyPageService.CompanyPageBrowseItem` (defined locally
 * to avoid the entities <-> profile circular module import; see `CompanyPageRef`).
 */
export interface InstitutePlacementEmployer {
  company: CompanyPageRef;
  /** Distinct CONFIRMED+opted-in students of this institute currently here. */
  studentCount: number;
}

/** The institute Placement wall result. The explicit empty marker (`employers: []`,
 *  `otherEmployerCount: 0`, `totalStudents: 0`) lets the web render the invite CTA. */
export interface InstitutePlacementResult {
  /** Employers that are CompanyPages on the platform, grouped + counted. */
  employers: InstitutePlacementEmployer[];
  /** Distinct students whose current employer is a free-text shop (no companyPageId). */
  otherEmployerCount: number;
  /** All confirmed+opted-in+public students of this institute considered. */
  totalStudents: number;
}

/**
 * Derive the single traveling "open to" status for a person card. hiring wins
 * over work (mutually exclusive in practice). Only an `audience: 'all'` intent
 * contributes here - a `network`-scoped intent returns null so it does not leak
 * into broad lists (its ring shows only on the profile page, which trims
 * per-viewer). Keep in sync with the web ConnectAvatar status contract.
 */
export function deriveOpenStatus(
  openTo?: { work?: boolean; hiring?: boolean },
  openToDetails?: {
    work?: { audience?: string };
    hiring?: { audience?: string };
  },
): ConnectOpenStatus {
  const audOk = (a?: string) => (a ?? 'all') === 'all';
  if (openTo?.hiring && audOk(openToDetails?.hiring?.audience)) return 'hiring';
  if (openTo?.work && audOk(openToDetails?.work?.audience)) return 'work';
  return null;
}

/**
 * A user's feed-ranking signals (Phase 3) — their `ConnectProfile` skills and
 * "open to" intent toggles. Consumed by `FeedService.scorePost` for the
 * `For You` persona-relevance term.
 */
export interface RankingSignals {
  skills: string[];
  openTo: ConnectOpenTo;
  /** Home district / textile hub — powers GeoLocal feed discovery. '' if unset. */
  district: string;
  /**
   * True for seeded demo/sample accounts (User.isDemo). Stamped onto a post at
   * create time (denormalized `Post.isDemo`) so the read-time ranker can
   * down-rank demo content + the FE can show the "Sample" badge, both off one
   * source. Returned by `getRankingSignals` only as the AUTHOR's flag at create
   * time; a feed VIEWER's own flag is irrelevant to ranking.
   */
  isDemo: boolean;
  /**
   * Directional affinity: how much THIS viewer has recently engaged with each
   * author (keyed by author user-id), decayed. Built per feed read from the
   * viewer's engagement edges; absent on surfaces that do not rank. The ranker
   * lifts authors the viewer interacts with. Near-zero for cold-start users.
   */
  affinity?: ReadonlyMap<string, number>;
  /**
   * Reader-feedback dampening (Phase 7d — "show me less"). Each is built per
   * feed read from the viewer's stored "not interested" marks + already-served
   * posts; the ranker multiplies them into a post's score (a DOWN-RANK, never an
   * exclusion — hide/mute/block do hard exclusion elsewhere). Absent on surfaces
   * that do not rank or for a viewer with no feedback. See
   * `feed/feed-feedback.ts` for the decay math and `feed.service.ts` for how the
   * maps are built.
   *
   * - `dampenByPost` — postId -> multiplier in (0,1] for a single not-interested
   *   mark on that post (decayed by a half-life).
   * - `dampenByAuthor` — authorId -> multiplier in (0,1] for a DERIVED
   *   not-interested-in-author (>= 3 post marks in 90d).
   * - `seenPostIds` — posts already SERVED to the viewer in a prior For-You page;
   *   the ranker applies a flat seen penalty so fresh content wins ties.
   */
  dampenByPost?: ReadonlyMap<string, number>;
  dampenByAuthor?: ReadonlyMap<string, number>;
  seenPostIds?: ReadonlySet<string>;
}

/**
 * Strict ObjectId-shape check. `Types.ObjectId.isValid` is liberal (returns
 * true for any 12-char string), which would let a 12-char username collide
 * with the dispatcher. The slug resolver demands exactly 24 hex chars to
 * route as an ObjectId; anything else is treated as a handle.
 */
function isHex24(s: string): boolean {
  return typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
}

/**
 * ConnectProfileService — owns the `ConnectProfile` lifecycle.
 *
 * Profiles are created LAZILY on first access (never auto-created for every
 * ERP user — `IDENTITY-MODEL.md`). `strength` is recomputed on every write.
 */
@Injectable()
export class ConnectProfileService {
  constructor(
    @InjectModel(ConnectProfile.name)
    private readonly profileModel: Model<ConnectProfile>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    /**
     * Domain-event bus. `ConnectProfileService` emits `connect.profile.changed`
     * on every profile create / content change; the Connect `SearchService`
     * listens and keeps its Meilisearch index warm. The emit is
     * fire-and-forget — `EventEmitterModule` is `forRoot`'d in `AppModule`.
     */
    private readonly eventEmitter: EventEmitter2,
    /**
     * Reads the person's Connect `verifiedBadge` entitlement for the public
     * profile's verified marker (M2.3). Imported via the allowance-only module
     * to avoid the AdsModule import cycle.
     */
    private readonly allowances: ConnectAllowanceService,
    /**
     * Folds the seller rating aggregate (avg + count) into the public profile
     * (marketplace Phase C, R2). Only attached when the person has at least one
     * rating; an unrated seller renders no stars. Optional so the service still
     * constructs in isolation (unit tests / degraded boot).
     */
    @Optional() private readonly reviews?: ReviewService,
    /**
     * The Connect `Connection` graph — read directly (not via `NetworkService`)
     * to gate `network`-audience "open to" intents on the public profile read.
     * Injecting `NetworkService` would create a circular module import
     * (ConnectNetworkModule already imports ConnectProfileModule) and pull in
     * its heavy deps (BullMQ queue, notifications); the model is the lean,
     * cycle-free dependency. Cross-module: reads the `Connection` collection
     * owned by ConnectNetworkModule, registered for read access in this module.
     * Optional so the service still constructs in isolation (unit tests /
     * degraded boot) — absent => every viewer is treated as NOT connected
     * (safe default: hide network-scoped intents).
     */
    @Optional()
    @InjectModel(Connection.name)
    private readonly connectionModel?: Model<Connection>,
    /**
     * The Connect `CompanyPage` collection - read directly (NOT via
     * `CompanyPageService`) to resolve the linked company on each experience
     * entry into a `{name,slug,logo,erpLinked}` ref for the profile read.
     * Injecting `CompanyPageService` / importing `ConnectEntitiesModule` would
     * create a circular module import (entities already imports this profile
     * module for `ErpLinkService`); the lean model is the cycle-free dependency.
     * Read-only; registered for read access in this module. Replicates the
     * `getRefs` projection locally and DROPS non-public/missing pages, so a
     * hidden page is simply absent from the map (web falls back to the
     * free-text `workshop` name - no leak). Optional so the service still
     * constructs in isolation (unit tests / degraded boot) - absent => empty map.
     */
    @Optional()
    @InjectModel(CompanyPage.name)
    private readonly companyPageModel?: Model<CompanyPage>,
    /**
     * The Connect `Storefront` collection — written ONLY by the account-erasure
     * cascade (ADR-0004): `handleAccountErased` revokes the ERP link on every
     * Storefront the erased user owns (in addition to the CompanyPage clear).
     * @Optional + declared LAST so positional unit-test constructors keep working;
     * absent => the storefront cleanup is skipped (a no-op, the model-less branch).
     */
    @Optional()
    @InjectModel(Storefront.name)
    private readonly storefrontModel?: Model<Storefront>,
    /**
     * Shared media-URL ownership guard (owned by UploadsModule). On profile
     * update we enforce that any NEWLY submitted banner / portfolio image URL
     * was uploaded by the caller (https + our-host + ownership), grandfathering
     * the URLs already stored on the profile. `@Optional()` and declared LAST
     * so positional unit-test constructors keep working without a stub.
     */
    @Optional() private readonly media?: MediaOwnershipService,
  ) {}

  /**
   * Institute-side seams (page-admin gate + audit/analytics/bell) for the
   * Institutes Phase 2 Feature 2 confirm/decline path. Wired at runtime by the
   * LEAF `ConnectInstitutesModule` (the only module that may see BOTH
   * `CompanyPageService` and this service without a cycle) via `setInstituteDeps`
   * below; `undefined` until then. The Feature 2 methods assert it is present.
   */
  private instituteDeps?: InstituteDeps;

  /**
   * Wire the institute-side dependencies (Institutes Phase 2, Feature 2). Called
   * once by `ConnectInstitutesModule.onModuleInit`. Setter-injection (not the
   * constructor) keeps `ConnectProfileService` free of any static import from
   * `ConnectEntitiesModule` / the notifications module, so no circular module
   * import is introduced (see the `InstituteDeps` doc-comment). Keep in sync with
   * the institutes module wiring.
   */
  setInstituteDeps(deps: InstituteDeps): void {
    this.instituteDeps = deps;
  }

  /** The caller's own profile — lazily created on first access. */
  async getOrCreateForUser(userId: string | Types.ObjectId): Promise<ConnectProfile> {
    const uid = new Types.ObjectId(userId);
    const existing = await this.profileModel.findOne({ userId: uid }).exec();
    if (existing) return existing;
    const created = await this.profileModel.create({ userId: uid });
    // A brand-new profile is searchable once it goes public — signal the
    // indexer. Only the create path emits; a cache hit above does not.
    this.emitProfileChanged(uid);
    // First Connect onboarding (Institutes Phase 2, Feature 5): signal the
    // first-touch referral handler (InstituteReferralService) so it can credit
    // the first institute that invited this user's mobile. Decoupled via the
    // global EventEmitter (no static dep on the institutes module = no cycle) and
    // best-effort: a listener fault must never fail the profile create.
    this.emitProfileCreated(uid);
    return created;
  }

  /**
   * The caller's own profile for the `/me/connect/profile` read - the lazily
   * created doc PLUS the resolved `experienceCompanies` map so the owner's
   * editor/preview shows the linked-company logos exactly like the public page.
   * Kept separate from `getOrCreateForUser` (whose live Mongoose doc the write
   * paths `update` / `completeOnboarding` still mutate via `.set`/`.save`); here
   * we convert to a plain object before attaching the map. Same hidden/missing
   * drop-rule as the public read - no leak.
   */
  async getOwnForUser(userId: string | Types.ObjectId): Promise<
    ConnectProfile & {
      experienceCompanies: Record<string, CompanyPageRef>;
      trainingCompanies: Record<string, CompanyPageRef>;
    }
  > {
    const doc = await this.getOrCreateForUser(userId);
    // toObject() so we can augment with the derived map (the raw doc is a
    // Mongoose document, not a plain object). Falls back to the doc itself if
    // toObject is unavailable (a plain-object mock in unit tests).
    const plain =
      typeof (doc as { toObject?: () => ConnectProfile }).toObject === 'function'
        ? (doc as { toObject: () => ConnectProfile }).toObject()
        : doc;
    return this.attachExperienceCompanies(plain);
  }

  /**
   * Public read of another user's profile. Only `public` profiles are exposed;
   * `connections` / `hidden` (and unknown ids) resolve to 404. Connections-aware
   * visibility lands in Phase 2 with the social graph.
   *
   * The User populate now includes `handle` so the public-profile page can
   * emit the canonical slug URL + the share UI can use the slug instead of
   * the ObjectId. `handle` is `null` for pre-backfill users — the web falls
   * back to the ObjectId URL in that case.
   */
  async getPublicByUserId(
    userId: string,
    viewerUserId?: string,
  ): Promise<
    ConnectProfile & {
      verified: boolean;
      rating?: RatingAggregate;
      experienceCompanies: Record<string, CompanyPageRef>;
      trainingCompanies: Record<string, CompanyPageRef>;
    }
  > {
    if (!isHex24(userId)) {
      throw new NotFoundException('Profile not found');
    }
    const profile = await this.profileModel
      .findOne({ userId: new Types.ObjectId(userId), visibility: 'public' })
      // Public profile needs the viewer-facing identity — name + avatar are
      // canonical on `User` (IDENTITY-MODEL.md), read here, never duplicated.
      // isDemo rides along so /u/[slug] can noindex demo profiles + show a
      // "Sample" header tag. See DEMO-CONTENT-TRUST-UX-PLAN.md (Phase 0/1).
      .populate('userId', 'name profilePicture handle isDemo')
      // Lean so the response is a plain object we can augment with the derived
      // `verified` marker; this is a read-only public read (no mutation).
      .lean<ConnectProfile>()
      .exec();
    if (!profile) throw new NotFoundException('Profile not found');
    // Orphaned-profile guard: a `ConnectProfile` row can outlive its owning
    // `User` (the user was hard-deleted but the public profile remained). The
    // `populate('userId')` above then resolves to `null`, yet the profile doc
    // itself matched, so the `!profile` check above passes. Without this guard
    // the endpoint returns a 200 with `userId: null`, which violates the
    // populated-`userId` contract every consumer relies on (the web `/u/[slug]`
    // + `/connect/u/[slug]` pages dereference `profile.userId.handle/_id/name`
    // and crash the whole route). A profile with no live owner IS a not-found.
    if (!profile.userId) {
      throw new NotFoundException('Profile not found');
    }
    // Per-intent audience gate: suppress `network`-scoped "open to" intents
    // for a viewer who is not a first-degree connection (or is logged out).
    // Runs BEFORE the verified/rating attach so the trimmed copy is returned.
    const trimmed = await this.trimByAudience(profile, userId, viewerUserId);
    // Login-gate the rate card: a person's quoted rates (daily wage / piece
    // rate / monthly) are commercial data shown to signed-in members only, not
    // anonymous crawlers. `viewerUserId` is undefined for a logged-out caller
    // (the `@Public` route's `OptionalJwtAuthGuard` left `req.user` empty), so
    // the field is stripped from the payload entirely -- never sent to the
    // client, not merely hidden in the UI. Keep in sync with the web
    // `ProfileView` rates lock + `feature` decision (owner, 2026-06-10).
    const gated = viewerUserId ? trimmed : { ...trimmed, rateCard: undefined };
    // Seller verified marker (M2.3): driven by the person's Connect
    // verifiedBadge entitlement, same default-on source as listings/search.
    const { verifiedBadge } = await this.allowances.getAllowances(userId);
    // Seller rating aggregate (R2): attach only when the person is actually
    // rated so an unrated seller renders no stars. The aggregate (star average)
    // stays public as social proof; the individual review LIST is login-gated
    // on the web side (the public reviews list endpoint is unchanged so company
    // pages / listings keep working).
    const rating = await this.reviews?.getAggregate(userId);
    // Resolve each experience entry's linked CompanyPage to {name,slug,logo,
    // erpLinked} so the web renders a logo + /company/[slug] link in one
    // round-trip. Hidden/missing pages are absent from the map (no leak).
    const withCompanies = await this.attachExperienceCompanies(gated);
    return {
      ...withCompanies,
      verified: verifiedBadge,
      ...(rating && rating.ratingCount > 0 ? { rating } : {}),
    };
  }

  /**
   * Suppress `network`-audience "open to" intents for a viewer who is not a
   * first-degree connection of the subject. Self + connections see everything.
   * Returns a copy with the boolean zeroed AND the detail dropped so the
   * response never leaks a hidden intent. Cross-module: reads the Connect
   * network connection graph. The owner's own /me/connect/profile read is
   * untrimmed (it never flows through this public read).
   */
  private async trimByAudience(
    profile: ConnectProfile,
    subjectUserId: string,
    viewerUserId?: string,
  ): Promise<ConnectProfile> {
    const isSelf = !!viewerUserId && viewerUserId === subjectUserId;
    const isConnection =
      isSelf || (!!viewerUserId && (await this.areConnected(subjectUserId, viewerUserId)));
    if (isConnection) return profile;
    const keys = ['work', 'hiring', 'deals', 'customOrders'] as const;
    const openTo = { ...(profile.openTo as unknown as Record<string, boolean>) };
    const details = {
      ...(profile.openToDetails as unknown as Record<string, { audience?: string }>),
    };
    let changed = false;
    for (const k of keys) {
      if (details[k]?.audience === 'network') {
        openTo[k] = false;
        delete details[k];
        changed = true;
      }
    }
    // Nothing network-scoped — return the original object untouched.
    if (!changed) return profile;
    return { ...profile, openTo, openToDetails: details } as unknown as ConnectProfile;
  }

  /**
   * Whether two `User`s are first-degree connected. Reads the canonical
   * ordered-pair `Connection` row directly (mirrors `NetworkService.sortedPair`:
   * `userA` holds the lexicographically-smaller id). Returns false when the
   * connection model is absent (unit tests / degraded boot) — the safe default
   * is "not connected", which hides network-scoped intents rather than leaking.
   */
  private async areConnected(a: string, b: string): Promise<boolean> {
    if (!this.connectionModel) return false;
    if (!isHex24(a) || !isHex24(b) || a === b) return false;
    const x = new Types.ObjectId(a);
    const y = new Types.ObjectId(b);
    const [userA, userB] = x.toHexString() <= y.toHexString() ? [x, y] : [y, x];
    const row = await this.connectionModel
      .findOne({ userA, userB })
      .select('_id')
      .lean<{ _id: Types.ObjectId } | null>()
      .exec();
    return row !== null;
  }

  /**
   * Resolve a set of CompanyPage ids to their minimal public ref
   * ({id,name,slug,logo,erpLinked}). Replicates `CompanyPageService.getRefs`
   * locally (same projection + same drop-rule) because importing the entities
   * service here would create a circular module import. Non-public/missing
   * pages are filtered out by the `visibility: 'public'` query, so they never
   * appear in the result. Returns [] when the model is absent (unit tests /
   * degraded boot). Cross-module: reads the Connect entities CompanyPage
   * collection (owned by ConnectEntitiesModule, registered read-only here).
   */
  private async companyRefs(ids: string[]): Promise<CompanyPageRef[]> {
    if (!this.companyPageModel) return [];
    const objectIds = ids
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return [];
    const pages = await this.companyPageModel
      // Only `public` pages resolve - a hidden/connections page must not leak
      // its identity onto someone else's profile read.
      .find({ _id: { $in: objectIds }, visibility: 'public' })
      .select('name slug logo erpWorkspaceId erpLink')
      .lean<
        Array<{
          _id: Types.ObjectId;
          name: string;
          slug: string;
          logo?: string;
          erpWorkspaceId?: Types.ObjectId | null;
          erpLink?: { status?: string } | null;
        }>
      >()
      .exec();
    // Consent-gated (ADR-0004): ERP-verified only when the entity's `erpLink`
    // status is `verified` AND a workspace pointer is present - same rule as the
    // entities service ref / browse card badge (`isEntityErpVerified`). A
    // dangling `erpWorkspaceId` from a revoked link never shows the badge.
    return pages.map((p) => ({
      id: String(p._id),
      name: p.name,
      slug: p.slug,
      logo: p.logo ?? '',
      erpLinked: p.erpLink?.status === 'verified' && !!p.erpWorkspaceId,
    }));
  }

  /**
   * Resolve the distinct linked CompanyPages on a profile's experience AND
   * training to two { pageId -> CompanyPageRef } maps. Hidden/missing pages are
   * dropped by the source, so they are simply absent (web falls back to the
   * free-text workshop / institute name). Both maps are built from ONE batched
   * companyRefs lookup over the union of ids, so a page linked by both an
   * experience and a training entry costs a single resolve. Cross-module: reads
   * the Connect entities CompanyPage refs. `trainingCompanies` is keyed exactly
   * like `experienceCompanies` so the web renders the institute logo +
   * /company/[slug] link identically (Institutes Phase 1).
   */
  private async attachExperienceCompanies<
    T extends {
      experience?: Array<{ companyPageId?: unknown }>;
      training?: Array<{ companyPageId?: unknown }>;
    },
  >(
    profile: T,
  ): Promise<
    T & {
      experienceCompanies: Record<string, CompanyPageRef>;
      trainingCompanies: Record<string, CompanyPageRef>;
    }
  > {
    const experienceIds = (profile.experience ?? [])
      .map((e) => (e.companyPageId ? String(e.companyPageId) : null))
      .filter((x): x is string => !!x);
    const trainingIds = (profile.training ?? [])
      .map((t) => (t.companyPageId ? String(t.companyPageId) : null))
      .filter((x): x is string => !!x);
    // One batched lookup over the union; split back into the two maps below.
    const unionIds = [...new Set([...experienceIds, ...trainingIds])];
    const byId: Record<string, CompanyPageRef> = {};
    if (unionIds.length) {
      const refs = await this.companyRefs(unionIds);
      for (const r of refs) byId[r.id] = r;
    }
    const experienceCompanies: Record<string, CompanyPageRef> = {};
    for (const id of new Set(experienceIds)) if (byId[id]) experienceCompanies[id] = byId[id];
    const trainingCompanies: Record<string, CompanyPageRef> = {};
    for (const id of new Set(trainingIds)) if (byId[id]) trainingCompanies[id] = byId[id];
    // Project each training credential for read output (Institutes Phase 2):
    // expose `id` / `confirmStatus` / `confirmedAt` / `shareWithInstitute` (so the
    // FE can render the confirm badge + round-trip the opt-in), but DROP the
    // institute-internal `confirmedByUserId` (never leaked on any read, public or
    // owner). Single chokepoint: both getOwnForUser + getPublicByUserId flow
    // through here. Applied in-place on the returned object (not a separate spread)
    // so the `T & {...}` return brand is preserved.
    //
    // ALWAYS emit `training` as an array. The read is a `.lean()` read, which
    // does NOT apply the schema's `default: []`, so a LEGACY doc created before
    // the `training` field existed (Institutes Phase 1) comes back with the key
    // omitted entirely. The read contract — mirrored on web `ConnectProfileBody.training`
    // (a required array, "empty for legacy docs") — says it is always an array,
    // and the web `ProfileView` reads `profile.training.length` unguarded. An
    // omitted field there throws "Cannot read properties of undefined (reading
    // 'length')" and blanks the whole profile route ("Connect could not load").
    // `projectTrainingForRead(undefined)` returns `[]`, so this normalizes legacy
    // docs without touching any doc that already carries training[].
    const result = { ...profile, experienceCompanies, trainingCompanies };
    result.training = this.projectTrainingForRead(profile.training) as T['training'];
    // Normalize EVERY additive array to [] when the lean read omitted the key.
    // Same root cause as `training` above: this is a `.lean()` read (getPublicByUserId),
    // which does NOT apply the schema's `default: []`, so a LEGACY doc saved before a
    // given array field existed comes back with that key omitted entirely. The read
    // contract — mirrored on web `ConnectProfileBody` (each typed as a required array,
    // "empty for legacy docs") — says these are always arrays, and the web `ProfileView`
    // reads `profile.services.length` / `.skills.length` / `.portfolio` / `.experience`
    // / `.recommendations` UNGUARDED. An omitted key there throws "Cannot read properties
    // of undefined (reading 'length')" and blanks the whole profile route. (`training`
    // and `videos` are already guarded on the web side; the rest are not, which is why a
    // pre-`services` profile crashed at `/connect/u/<id>`.) The owner read goes through
    // `toObject()` which DOES apply defaults, so this only bites public reads of legacy
    // docs. Single chokepoint: both getOwnForUser + getPublicByUserId flow through here.
    // Keep this list in sync with the array fields on web `ConnectProfileBody`.
    const arrayFields = [
      'skills',
      'portfolio',
      'experience',
      'services',
      'recommendations',
      'videos',
    ];
    const mutable = result as Record<string, unknown>;
    for (const field of arrayFields) {
      if (mutable[field] == null) mutable[field] = [];
    }
    return result;
  }

  /**
   * Strip institute-internal fields from a training[] for any read response. We
   * expose the confirm badge inputs (`id`, `confirmStatus`, `confirmedAt`,
   * `shareWithInstitute`) and the Phase 1 display fields, but never the
   * `confirmedByUserId` audit pointer (that is institute-side only). Defensive on
   * shape: a legacy Phase 1 credential without confirm fields simply renders as
   * `confirmStatus: 'self'` defaulted by the schema. Cross-module: the web confirm
   * badge renderer consumes exactly these fields.
   */
  private projectTrainingForRead(
    training: ReadonlyArray<Record<string, unknown>> | undefined,
  ): Array<Record<string, unknown>> {
    return (training ?? []).map((t) => {
      // Omit confirmedByUserId; pass through everything else untouched. Typed on
      // the read view (a plain object) rather than the schema class, so a lean()
      // read object and a toObject() owner read both flow through unchanged.
      const { confirmedByUserId: _drop, ...rest } = t;
      void _drop;
      return rest;
    });
  }

  /**
   * Public read by slug — resolves the slug to a userId via the dual-input
   * dispatcher, then delegates to `getPublicByUserId`. A 24-hex-char slug is
   * treated as an ObjectId (legacy URLs continue to resolve); anything else
   * is matched case-insensitively against `User.handle`.
   */
  async getPublicBySlug(
    slug: string,
    viewerUserId?: string,
  ): Promise<
    ConnectProfile & {
      verified: boolean;
      rating?: RatingAggregate;
      experienceCompanies: Record<string, CompanyPageRef>;
      trainingCompanies: Record<string, CompanyPageRef>;
    }
  > {
    const userId = await this.resolveSlugToUserId(slug);
    return this.getPublicByUserId(userId, viewerUserId);
  }

  /**
   * Resolve a public-profile slug (handle OR ObjectId hex) to a User _id.
   * Throws `NotFoundException` for an unknown slug — consumers (the erp-link
   * endpoint, the profile read) propagate that as a 404 to the client.
   */
  async resolveSlugToUserId(slug: string): Promise<string> {
    if (!slug || typeof slug !== 'string') {
      throw new NotFoundException('Profile not found');
    }
    if (isHex24(slug)) return slug.toLowerCase();
    const user = await this.userModel
      .findOne({ handle: slug.toLowerCase() })
      .collation({ locale: 'en', strength: 2 })
      .select('_id')
      .lean<{ _id: Types.ObjectId } | null>()
      .exec();
    if (!user) throw new NotFoundException('Profile not found');
    return user._id.toString();
  }

  /**
   * Apply a partial update, recompute `strength`, persist, and return the SAME
   * projected view the GET read returns (NOT the raw saved Mongoose doc).
   *
   * Returning the raw doc here previously leaked the institute-internal
   * `training[].confirmedByUserId`: the PATCH response is serialized straight to
   * the client (no global `ClassSerializerInterceptor`, no `@Exclude`), and the
   * web editor repaints local state from that body, so the audit pointer reached
   * the client, bypassing the `projectTrainingForRead()` chokepoint that the GET
   * (`getOwnForUser`) and the public read both flow through, and contradicting
   * this file's own stated invariant (`confirmedByUserId` is never leaked on any
   * read, public or owner). We now re-read through `getOwnForUser`, the single
   * projection chokepoint, so the PATCH and GET responses are byte-for-byte the
   * same shape: `confirmedByUserId` stripped, `trainingCompanies` /
   * `experienceCompanies` attached. Cross-module: the institute-side confirm path
   * (Feature 2/3) is the only writer of `confirmedByUserId`; this read never
   * surfaces it. Keep in sync with the `projectTrainingForRead` field list.
   */
  async update(
    userId: string | Types.ObjectId,
    dto: UpdateConnectProfileDto,
  ): Promise<
    ConnectProfile & {
      experienceCompanies: Record<string, CompanyPageRef>;
      trainingCompanies: Record<string, CompanyPageRef>;
    }
  > {
    const profile = await this.getOrCreateForUser(userId);

    // Media-URL ownership: enforce that any NEWLY submitted banner / portfolio
    // image URL was uploaded by this caller, via the shared media-ownership
    // guard (UploadsModule). This is an UPDATE path, so the media already stored
    // on the profile is grandfathered (the guard skips ownership for those, but
    // still validates host + protocol). Captured BEFORE the mutation loop below.
    const submitted = [dto.banner, ...(dto.portfolio?.map((p) => p.image) ?? [])];
    const existingMedia = [profile.banner, ...(profile.portfolio ?? []).map((p) => p.image)];
    await this.media.assertOwnedMedia(submitted, String(userId), {
      grandfatheredUrls: existingMedia,
    });

    // Video is stamped (server duration) + ownership-checked here, NOT in the
    // generic UPDATABLE_FIELDS loop - routing it through `profile.set` would
    // bypass ownership/duration derivation and trust a client durationSec.
    // Mirrors how ListingService handles `videos` outside its EDITABLE_FIELDS.
    // The profile's existing video is grandfathered (its url/posterUrl predate
    // this edit). An omitted `videos` leaves the existing one untouched; an
    // explicit `videos: []` clears it.
    if (dto.videos !== undefined) {
      const built = await this.buildOwnedVideos(
        dto.videos,
        String(userId),
        profile.videos as Array<{ url: string; posterUrl?: string }> | undefined,
      );
      profile.set('videos', built);
    }

    // Training credentials are reconciled against the PRIOR stored list, NOT
    // blindly overwritten from the DTO (Institutes Phase 2 write-guard). This
    // preserves any institute confirmation + its audit trail and makes it
    // IMPOSSIBLE for the student PATCH to forge `confirmed` / `declined` or set
    // confirm metadata. Handled here (outside the generic UPDATABLE_FIELDS loop,
    // which would clobber the reconciliation), mirroring how `videos` is handled.
    // An omitted `training` leaves the stored list untouched; an explicit `[]`
    // clears it. Cross-module: the institute-side confirm path (Feature 2/3) is
    // the ONLY writer of `confirmed` / `declined` + confirmedAt/confirmedByUserId.
    if (dto.training !== undefined) {
      const reconciled = this.reconcileTraining(
        dto.training,
        profile.training as unknown as StoredTrainingItem[] | undefined,
      );
      profile.set('training', reconciled);
    }

    // Broker self-declaration (Broker badge, Slice 1): stamp `brokerSince` ONCE
    // on the false→true flip, only when it is not already set, so the badge's
    // "broker since" track record is preserved across later toggles. `isBroker`
    // itself is persisted by the generic UPDATABLE_FIELDS loop below;
    // `brokerSince` is service-stamped only (never accepted from the DTO),
    // mirroring how `onboardedAt` is stamped once in `completeOnboarding`.
    if (dto.isBroker === true && !profile.isBroker && !profile.brokerSince) {
      profile.set('brokerSince', new Date());
    }

    for (const field of UPDATABLE_FIELDS) {
      // `training` is reconciled above (write-guard); never route it through the
      // generic overwrite, which would let a student-sent status win.
      if (field === 'training') continue;
      const value = dto[field];
      if (value !== undefined) profile.set(field, value);
    }
    profile.set('strength', this.computeStrength(profile));

    await profile.save();
    // Content changed — re-index. `headline` / `skills` / `visibility` are all
    // in `UPDATABLE_FIELDS`, so any edit can move what search should surface.
    this.emitProfileChanged(String(profile.userId));
    // Return the PROJECTED owner view (not the raw saved doc) so the PATCH
    // response is identical to the GET read: strips training[].confirmedByUserId
    // via the projectTrainingForRead chokepoint and attaches the company maps.
    // `getOwnForUser` re-reads the just-saved doc (the in-memory profile is
    // already persisted above), so the returned `_id` the controller audits is
    // unchanged.
    return this.getOwnForUser(userId);
  }

  /**
   * Profile-completeness, 0–100. A weighted checklist — portfolio + skills are
   * weighted highest because, for karigars, visual proof matters most
   * (design-decisions doc §1.1).
   */
  computeStrength(
    p: Pick<
      ConnectProfile,
      'headline' | 'bio' | 'banner' | 'skills' | 'portfolio' | 'experience' | 'rateCard'
    >,
  ): number {
    let score = 0;
    if (p.headline?.trim()) score += STRENGTH_WEIGHTS.headline;
    if (p.bio?.trim()) score += STRENGTH_WEIGHTS.bio;
    if (p.banner?.trim()) score += STRENGTH_WEIGHTS.banner;
    if ((p.skills?.length ?? 0) >= 3) score += STRENGTH_WEIGHTS.skills;
    if ((p.portfolio?.length ?? 0) >= 1) score += STRENGTH_WEIGHTS.portfolio;
    if ((p.experience?.length ?? 0) >= 1) score += STRENGTH_WEIGHTS.experience;
    const rate = p.rateCard;
    if (rate && (rate.dailyWage || rate.pieceRate || rate.monthly)) {
      score += STRENGTH_WEIGHTS.rateCard;
    }
    return score;
  }

  /**
   * `/connect` smart-entry state — does this user have Connect access, and
   * have they finished onboarding? Reads `connectEnabled` from `User` and
   * `onboardedAt` from the profile WITHOUT lazily creating a profile (a
   * not-enabled user must never get one).
   */
  async getEntryState(
    userId: string | Types.ObjectId,
  ): Promise<{ connectEnabled: boolean; onboarded: boolean; policyAccepted: boolean }> {
    const uid = new Types.ObjectId(userId);
    const user = await this.userModel
      .findById(uid)
      .select('connectEnabled connectPolicyAcceptedAt')
      .lean<{ connectEnabled?: boolean; connectPolicyAcceptedAt?: Date | null }>()
      .exec();
    // Connect is default-on (User.connectEnabled schema default = true; the
    // Wave-0 rollout enabled every user without an admin flip). So a user is
    // gated out ONLY when the flag is EXPLICITLY false; an absent flag (an
    // older / seeded / not-backfilled doc) must be treated as enabled, never
    // mis-degraded to the "coming soon" dead-end. A missing user record is the
    // sole other no-access case.
    if (!user || user.connectEnabled === false) {
      return { connectEnabled: false, onboarded: false, policyAccepted: false };
    }
    const profile = await this.profileModel
      .findOne({ userId: uid })
      .select('onboardedAt')
      .lean<{ onboardedAt?: Date | null }>()
      .exec();
    return {
      connectEnabled: true,
      onboarded: !!profile?.onboardedAt,
      policyAccepted: !!user.connectPolicyAcceptedAt,
    };
  }

  /** Stamp the Connect policy/terms acceptance (idempotent — first write wins). */
  async acceptPolicy(userId: string | Types.ObjectId): Promise<{ acceptedAt: Date }> {
    const uid = new Types.ObjectId(userId);
    const now = new Date();
    await this.userModel
      .updateOne(
        { _id: uid, connectPolicyAcceptedAt: { $in: [null, undefined] } },
        { $set: { connectPolicyAcceptedAt: now } },
      )
      .exec();
    const user = await this.userModel
      .findById(uid)
      .select('connectPolicyAcceptedAt')
      .lean<{ connectPolicyAcceptedAt?: Date | null }>()
      .exec();
    return { acceptedAt: user?.connectPolicyAcceptedAt ?? now };
  }

  /**
   * Mark the onboarding intent flow complete. Stamps `onboardedAt` once
   * (never overwritten), persists the chosen persona on `onboardingIntent`
   * (so downstream cross-sell surfaces can read it), and applies the single
   * intent-driven pre-set: a karigar is set open-to-work. The intent also
   * drives the analytics event.
   */
  async completeOnboarding(
    userId: string | Types.ObjectId,
    intent: ConnectOnboardingIntent,
  ): Promise<ConnectProfile> {
    const profile = await this.getOrCreateForUser(userId);
    if (!profile.onboardedAt) profile.set('onboardedAt', new Date());
    profile.set('onboardingIntent', intent);
    if (intent === 'karigar') profile.set('openTo.work', true);
    await profile.save();
    // Onboarding can flip an intent pre-set — re-index the now-onboarded
    // person. (A first-touch onboarding already emitted via `getOrCreateForUser`
    // above; a second emit here is harmless — `indexPerson` is idempotent.)
    this.emitProfileChanged(String(profile.userId));
    return profile;
  }

  /**
   * Curated "featured workshops" for the Day-1 home.
   *
   * Pre-reframe this filtered `ConnectProfile`s on `primaryWorkspace`. Connect
   * is now a standalone product — a `ConnectProfile` is Person-scoped and
   * carries no workspace reference, so a profile can no longer identify a
   * "workshop". Featured workshops will instead be backed by `CompanyPage`
   * entities in Phase 6 (company/workshop pages on the network).
   *
   * Until then this returns an empty array. The method + its `Promise`-typed
   * signature are kept so the `featured-workshops` endpoint's contract holds;
   * the web Day-1 home already renders an empty-state for this feed.
   */
  getFeaturedWorkshops(): Promise<ConnectProfile[]> {
    return Promise.resolve<ConnectProfile[]>([]);
  }

  /**
   * Reconcile an incoming student-submitted training[] against the PRIOR stored
   * list (Institutes Phase 2 write-guard). The net invariant: nothing a STUDENT
   * sends can ever produce `confirmed` / `declined`, and `confirmedAt` /
   * `confirmedByUserId` can never be set through this path. An institute's prior
   * decision is authoritative and is preserved across the student's edits.
   *
   * Per incoming item, matched to a prior item by stable `id`:
   *  - EXISTING (id matches a prior item):
   *      * keep prior `confirmedAt` / `confirmedByUserId` as the baseline.
   *      * if the prior status is `confirmed` / `declined` AND the companyPageId
   *        did NOT change -> KEEP the prior status (the institute's call wins;
   *        the student-sent self|pending is ignored).
   *      * otherwise -> status = (incoming `pending` AND companyPageId set)
   *        ? `pending` : `self`, and clear confirmedAt / confirmedByUserId
   *        (a re-link to a different institute, or a self-typed edit, drops any
   *        stale confirmation, the new institute never confirmed it).
   *  - NEW (no id / unknown id): assign a fresh ObjectId-hex `id`; status =
   *    (incoming `pending` AND companyPageId set) ? `pending` : `self`;
   *    confirmedAt / confirmedByUserId = null (a NEW credential can never arrive
   *    pre-confirmed from a student).
   * `shareWithInstitute` is always taken from the student (their own opt-in).
   *
   * Cross-module: the confirm-* fields are otherwise written ONLY by the
   * institute-side confirm path (Feature 2/3), which matches by the same `id`.
   * Keep the id-matching contract in sync with that path.
   */
  private reconcileTraining(
    incoming: IncomingTrainingItem[],
    prior: StoredTrainingItem[] | undefined,
  ): StoredTrainingItem[] {
    const priorById = new Map<string, StoredTrainingItem>();
    for (const p of prior ?? []) {
      if (p && typeof p.id === 'string' && p.id) priorById.set(p.id, p);
    }

    const sameCompany = (a: unknown, b: unknown): boolean => {
      // Normalise both sides to a string for comparison (ObjectId | string |
      // null | undefined). Absent on both sides counts as unchanged. An ObjectId
      // is normalised via its hex string (a raw String() on an unknown could be
      // a default [object Object]); a string stays as-is; anything else is empty.
      const norm = (v: unknown): string => {
        if (v == null) return '';
        if (v instanceof Types.ObjectId) return v.toHexString();
        if (typeof v === 'string') return v;
        return '';
      };
      return norm(a) === norm(b);
    };
    const wantsPending = (item: IncomingTrainingItem): boolean =>
      item.confirmStatus === 'pending' && item.companyPageId != null;

    return incoming.map((item) => {
      const match = item.id ? priorById.get(item.id) : undefined;

      if (match) {
        const companyChanged = !sameCompany(match.companyPageId, item.companyPageId);
        const priorLocked =
          match.confirmStatus === 'confirmed' || match.confirmStatus === 'declined';

        // The institute's decision stands unless the credential was re-linked to
        // a different institute (or unlinked).
        if (priorLocked && !companyChanged) {
          return {
            ...item,
            id: match.id,
            confirmStatus: match.confirmStatus,
            confirmedAt: match.confirmedAt ?? null,
            confirmedByUserId: match.confirmedByUserId ?? null,
            shareWithInstitute: !!item.shareWithInstitute,
          };
        }

        // Otherwise the student controls the status (capped at self|pending) and
        // any stale confirmation is dropped.
        return {
          ...item,
          id: match.id,
          confirmStatus: wantsPending(item) ? 'pending' : 'self',
          confirmedAt: null,
          confirmedByUserId: null,
          shareWithInstitute: !!item.shareWithInstitute,
        };
      }

      // NEW credential: a student can never mint one pre-confirmed.
      return {
        ...item,
        id: new Types.ObjectId().toHexString(),
        confirmStatus: wantsPending(item) ? 'pending' : 'self',
        confirmedAt: null,
        confirmedByUserId: null,
        shareWithInstitute: !!item.shareWithInstitute,
      };
    });
  }

  // ─── Institutes Phase 2, Feature 2: institute-side confirm / decline ─────────

  /**
   * List the PENDING credential requests linking a given institute CompanyPage,
   * for the page owner's review queue (Institutes Phase 2, Feature 2). Page-admin
   * only: gated through `CompanyPageService.getMine` (404 for a non-owner, no
   * existence leak), wired via `setInstituteDeps`.
   *
   * Returns, per matching profile, the student identity (userId / name / handle /
   * avatar, where name + avatar are canonical on `User`), the matching training
   * entry(ies) with `confirmStatus === 'pending'` AND `companyPageId === pageId`,
   * and the resolved institute company ref. Only `pending` rows surface here: `self`
   * (student-typed, never asked for confirmation), `confirmed`, and `declined`
   * entries are excluded, and an entry linking a DIFFERENT page is never returned
   * (no PII from other institutes). The student lookup is BATCHED (one `$in`
   * query over all matched students), never N+1. Cross-module: reads the
   * `ConnectProfile` training[] (this module), the `User` identity (this module),
   * and resolves the `CompanyPage` ref (entities, via `companyRefs`).
   */
  async listPendingCredentialRequests(
    pageOwnerUserId: string,
    pageId: string,
  ): Promise<PendingCredentialRequest[]> {
    // Page-admin gate FIRST: a non-owner (or unknown page) 404s before any
    // ConnectProfile scan, so a stranger can never enumerate an institute's queue.
    const deps = this.requireInstituteDeps();
    await deps.companyPages.getMine(pageOwnerUserId, pageId);

    if (!Types.ObjectId.isValid(pageId)) return [];
    const pageObjectId = new Types.ObjectId(pageId);

    // $elemMatch so the doc-level match requires ONE training entry that is BOTH
    // this page AND pending (not the cross-product of two separate conditions).
    const profiles = await this.profileModel
      .find({
        training: { $elemMatch: { companyPageId: pageObjectId, confirmStatus: 'pending' } },
      })
      .select('userId training')
      .lean<
        Array<{
          userId: Types.ObjectId;
          training?: Array<Record<string, unknown>>;
        }>
      >()
      .exec();
    if (profiles.length === 0) return [];

    // Flatten to (student, matching-entry) rows. A student may have more than one
    // pending credential for the same institute (e.g. two different courses).
    const pageHex = pageObjectId.toHexString();
    const flat: Array<{ studentId: string; training: Record<string, unknown> }> = [];
    for (const p of profiles) {
      const studentId = String(p.userId);
      for (const t of p.training ?? []) {
        const sameStatus = t.confirmStatus === 'pending';
        const samePage = t.companyPageId != null && this.normalizeId(t.companyPageId) === pageHex;
        if (sameStatus && samePage) {
          // Strip the institute-internal confirmedByUserId before it leaves the
          // service (it is null on a pending row anyway, but keep the chokepoint).
          const { confirmedByUserId: _drop, ...rest } = t;
          void _drop;
          flat.push({ studentId, training: rest });
        }
      }
    }
    if (flat.length === 0) return [];

    // Batch the student identity lookup (one $in over the distinct ids); no N+1.
    const studentIds = [...new Set(flat.map((r) => r.studentId))]
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    const users = await this.userModel
      .find({ _id: { $in: studentIds } })
      .select('name profilePicture handle')
      .lean<
        Array<{ _id: Types.ObjectId; name?: string; profilePicture?: string; handle?: string }>
      >()
      .exec();
    const studentById = new Map<string, CredentialStudentRef>(
      users.map((u) => [
        String(u._id),
        {
          userId: String(u._id),
          name: u.name ?? '',
          avatar: u.profilePicture ?? null,
          handle: u.handle ?? null,
        },
      ]),
    );

    // Resolve the institute company ref once (all rows link THIS page). Hidden /
    // missing pages drop to null (same no-leak rule as the profile read).
    const refs = await this.companyRefs([pageHex]);
    const company = refs[0] ?? null;

    return flat.map((r) => ({
      student: studentById.get(r.studentId) ?? {
        userId: r.studentId,
        name: '',
        avatar: null,
        handle: null,
      },
      training: r.training,
      company,
    }));
  }

  /**
   * Confirm or decline ONE student credential as the institute page owner
   * (Institutes Phase 2, Feature 2). This is the ONLY code path that may set a
   * credential's `confirmStatus` to `confirmed` / `declined` and write its
   * `confirmedAt` / `confirmedByUserId` (the student PATCH path can never produce
   * those, see `reconcileTraining`).
   *
   * Gate: `CompanyPageService.getMine(pageOwnerUserId, pageId)` (404 for a
   * non-owner). Then load the student's profile and locate the training entry by
   * `id === trainingId` AND `companyPageId === pageId`. An admin may ONLY touch
   * credentials that link THEIR page, so a credential linking another institute
   * (or no page) 404s (cross-institute write blocked, no existence leak).
   *
   * On `confirm`: `confirmStatus = 'confirmed'`, `confirmedAt = <now>`,
   * `confirmedByUserId = pageOwnerUserId`. On `decline`: `confirmStatus =
   * 'declined'`, `confirmedAt = null`, `confirmedByUserId = null`. The element is
   * mutated in place + `save()`d (the multikey `training[]` subdoc has no `_id`,
   * so a positional update would need arrayFilters; load-modify-save on the live
   * doc is the simpler, race-safe-enough choice for a single-admin action).
   *
   * Audit + posthog fire on each decision; a best-effort student bell is
   * dispatched and never fails the write. Cross-module: audit/posthog are the
   * @Global write seams; the bell is the notifications module; all wired via
   * `setInstituteDeps`.
   */
  async decideCredential(
    pageOwnerUserId: string,
    pageId: string,
    studentUserId: string,
    trainingId: string,
    decision: 'confirm' | 'decline',
  ): Promise<{ ok: true; confirmStatus: ConnectTrainingConfirmStatus }> {
    const deps = this.requireInstituteDeps();
    // Page-admin gate FIRST (404 for a non-owner before any student load).
    await deps.companyPages.getMine(pageOwnerUserId, pageId);

    // A non-ObjectId trainingId / studentId can never match a stored credential.
    if (!Types.ObjectId.isValid(trainingId) || !Types.ObjectId.isValid(studentUserId)) {
      throw new NotFoundException('Credential not found');
    }
    if (!Types.ObjectId.isValid(pageId)) {
      throw new NotFoundException('Credential not found');
    }
    const pageHex = new Types.ObjectId(pageId).toHexString();

    // Load the LIVE student profile doc (not lean) so we can mutate + save the
    // matched subdoc.
    const profile = await this.profileModel
      .findOne({ userId: new Types.ObjectId(studentUserId) })
      .exec();
    if (!profile) throw new NotFoundException('Credential not found');

    const training = (profile.training ?? []) as unknown as Array<{
      id?: string;
      companyPageId?: unknown;
      confirmStatus?: ConnectTrainingConfirmStatus;
      confirmedAt?: Date | null;
      confirmedByUserId?: Types.ObjectId | null;
    }>;
    // Match on BOTH the stable id AND this page: an admin may only act on a
    // credential that links THEIR institute (cross-institute write blocked).
    const item = training.find(
      (t) =>
        t.id === trainingId &&
        t.companyPageId != null &&
        this.normalizeId(t.companyPageId) === pageHex,
    );
    if (!item) throw new NotFoundException('Credential not found');

    if (decision === 'confirm') {
      item.confirmStatus = 'confirmed';
      item.confirmedAt = new Date();
      item.confirmedByUserId = new Types.ObjectId(pageOwnerUserId);
    } else {
      item.confirmStatus = 'declined';
      item.confirmedAt = null;
      item.confirmedByUserId = null;
    }
    // The subdoc array was mutated in place; flag it so Mongoose persists it.
    if (typeof (profile as { markModified?: (p: string) => void }).markModified === 'function') {
      (profile as { markModified: (p: string) => void }).markModified('training');
    }
    await profile.save();

    const action =
      decision === 'confirm' ? 'connect_credential_confirmed' : 'connect_credential_declined';
    const event =
      decision === 'confirm' ? 'connect.credential_confirmed' : 'connect.credential_declined';
    await deps.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'ConnectTrainingCredential',
      entityId: trainingId,
      action,
      actorId: pageOwnerUserId,
      meta: { pageId, studentUserId },
    });
    deps.posthog?.capture({
      distinctId: pageOwnerUserId,
      event,
      properties: { pageId, studentUserId, trainingId },
    });
    // Best-effort student bell; never fails the write.
    void deps.notifications
      ?.dispatch({
        recipientId: new Types.ObjectId(studentUserId),
        actorId: new Types.ObjectId(pageOwnerUserId),
        category: event,
        entityType: 'ConnectTrainingCredential',
        entityId: trainingId,
        title: decision === 'confirm' ? 'Training confirmed' : 'Training not confirmed',
        message:
          decision === 'confirm'
            ? 'The institute confirmed your training credential.'
            : 'The institute could not confirm your training credential.',
      })
      .catch(() => undefined);

    return { ok: true, confirmStatus: item.confirmStatus };
  }

  // ─── Institutes Phase 2, Feature 3: institute-page PUBLIC reads ──────────────

  /**
   * The page gate for the two PUBLIC institute reads (alumni / placements). A
   * `@Public()` controller may call these logged-out, so the gate must be
   * server-side and strict: the page must EXIST, be `kind: 'institute'`, AND be
   * `visibility: 'public'`. Anything else (missing id, a business page, a
   * hidden/connections page, an invalid hex) is a 404 - never an existence leak,
   * never a "this page is private" tell. Returns the lean page (name carried for
   * the web heading). Reads the entities CompanyPage collection directly (the
   * same cycle-free model this service already injects for `companyRefs`); when
   * the model is absent (degraded boot / a unit test without it) every page is
   * treated as not-found so the public surface fails closed. Keep in sync with
   * `CompanyPageService.isPublicById` + the institute `kind` enum.
   */
  private async loadPublicInstitute(
    pageId: string,
  ): Promise<{ _id: Types.ObjectId; name: string }> {
    if (!this.companyPageModel || !isHex24(pageId)) {
      throw new NotFoundException('Institute not found');
    }
    const page = await this.companyPageModel
      .findOne({ _id: new Types.ObjectId(pageId), kind: 'institute', visibility: 'public' })
      .select('name')
      .lean<{ _id: Types.ObjectId; name?: string } | null>()
      .exec();
    if (!page) throw new NotFoundException('Institute not found');
    return { _id: page._id, name: page.name ?? '' };
  }

  /**
   * PUBLIC institute Alumni / Open-to-work tab (Feature 3). Lists, cursor-
   * paginated newest-first, the people who:
   *  - have a training credential linking THIS institute's CompanyPage
   *    (`companyPageId === pageId`, ANY confirmStatus - "confirmed OR linked"),
   *  - opted that single credential in (`shareWithInstitute === true`, DPDP),
   *  - whose profile is `visibility: 'public'`, AND
   *  - who are `openTo.work === true`.
   * Returns ConnectPerson-shaped items (reusing the batched `getPeopleByIds`
   * hydration, so no N+1), each tagged `openStatus: 'work'`.
   *
   * GATING (server-side, never the client): a hidden / connections-only profile,
   * or a credential that is not opted-in, can never satisfy the Mongo filter, so
   * it never reaches the result; the per-row re-check below is defence in depth so
   * a doc whose ONLY this-page credential is NOT opted-in (but a DIFFERENT opted-in
   * credential made the doc-level `$elemMatch` pass) is still dropped. Strictly
   * scoped to `pageId` (no cross-institute leakage). Cross-module: reads the
   * ConnectProfile training[] (this module) + resolves identity via `getPeopleByIds`
   * (User + ConnectProfile). Keep the filter in sync with the schema index
   * `{ 'training.companyPageId': 1, 'training.confirmStatus': 1 }`.
   */
  async getInstituteAlumni(
    pageId: string,
    opts: { cursor?: string | null; limit?: number },
  ): Promise<InstituteAlumniResult> {
    // Page gate FIRST (404 for a missing / business / hidden page) before any scan.
    await this.loadPublicInstitute(pageId);
    const pageObjectId = new Types.ObjectId(pageId);
    const pageHex = pageObjectId.toHexString();

    const limit = clampPageSize(opts.limit);
    const cursor = decodeCursor(opts.cursor);

    // Doc-level AND: public + open-to-work + an opted-in credential for THIS page.
    // The `$elemMatch` keeps the two array conditions on the SAME element (not the
    // cross-product), so a doc only matches when ONE credential is both this page
    // AND opted-in. `confirmStatus` is intentionally unconstrained here (alumni =
    // "confirmed OR linked"). Newest-first by (createdAt, _id) with the keyset
    // cursor; over-fetch limit+1 so `buildPage` can compute `nextCursor`.
    const rows = await this.profileModel
      .find({
        visibility: 'public',
        'openTo.work': true,
        training: {
          $elemMatch: { companyPageId: pageObjectId, shareWithInstitute: true },
        },
        ...keysetFilter(cursor),
      })
      .select('userId createdAt training')
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean<
        Array<{
          _id: Types.ObjectId;
          userId: Types.ObjectId;
          createdAt: Date;
          training?: Array<{ companyPageId?: unknown; shareWithInstitute?: boolean }>;
        }>
      >()
      .exec();

    // Defence in depth: re-assert that the row carries at least one opted-in
    // credential for THIS exact page (the $elemMatch already guarantees it, but the
    // re-check makes the per-page scoping explicit + robust to any future filter
    // drift). Rows that fail are dropped before pagination so `total` is accurate.
    const matched = rows.filter((r) =>
      (r.training ?? []).some(
        (t) =>
          t.shareWithInstitute === true &&
          t.companyPageId != null &&
          this.normalizeId(t.companyPageId) === pageHex,
      ),
    );
    if (matched.length === 0) {
      return { items: [], total: 0, nextCursor: null };
    }

    // Page the over-fetched window: trims to `limit` + computes the keyset cursor.
    const { items: pageRows, nextCursor } = buildPage(matched, limit);

    // Batched identity hydration (one getPeopleByIds call = two $in queries). The
    // person's traveling openStatus is recomputed inside getPeopleByIds; we PIN it
    // to 'work' here (the tab is the open-to-work list) so the card always reads as
    // open-to-work even if their broadcast audience is network-scoped.
    const userIds = pageRows.map((r) => String(r.userId));
    const people = await this.getPeopleByIds(userIds);
    const personById = new Map(people.map((p) => [p.userId, p]));

    // Preserve the scan's newest-first order (getPeopleByIds does not guarantee it).
    const itemsList: InstituteAlumnus[] = [];
    for (const r of pageRows) {
      const p = personById.get(String(r.userId));
      if (!p) continue; // an orphaned profile (no live User) is simply skipped.
      itemsList.push({
        userId: p.userId,
        name: p.name,
        headline: p.headline,
        avatarUrl: p.avatar,
        openStatus: 'work',
      });
    }
    return { items: itemsList, total: itemsList.length, nextCursor };
  }

  /**
   * PUBLIC institute Placement wall ("where our students work", Feature 3). From
   * the institute's CONFIRMED (`confirmStatus === 'confirmed'`), opted-in
   * (`shareWithInstitute === true`), `public` students, derives each student's
   * CURRENT employer = the experience entry with `to == null`/unset (the documented
   * "currently working here" signal); when a student has several current entries,
   * the most recent by `from` wins. Groups by employer: entries with a
   * `companyPageId` resolve to a CompanyPage ref + a distinct-student count;
   * free-text employers (no companyPageId) aggregate into a single
   * `otherEmployerCount`. A confirmed+opted-in student with NO current job counts
   * toward `totalStudents` but contributes to no employer.
   *
   * This INVENTS no employment store - it derives only from `experience.to == null`
   * (self-declared). The frame is display-only, NOT a verified placement. GATING is
   * server-side: a hidden/connections profile or a non-confirmed / not-opted-in
   * credential never satisfies the filter; strictly scoped to `pageId`. Cross-
   * module: reads the ConnectProfile training[]/experience[] (this module) +
   * resolves employer CompanyPage refs via the batched `companyRefs` (entities,
   * one $in). No keyset pagination (a placement wall shows the full grouped set);
   * the scan is bounded by the shared `LIST_HARD_CAP` DoS backstop since this is a
   * @Public() route whose read grows with the institute's confirmed-alumni count.
   * An optional `limit` is honoured as a REAL cap (clamped down to LIST_HARD_CAP,
   * never above it), so a client can ask for less but never more than the ceiling.
   */
  async getInstitutePlacements(
    pageId: string,
    opts: { limit?: number },
  ): Promise<InstitutePlacementResult> {
    // Page gate FIRST (404 for a missing / business / hidden page) before any scan.
    await this.loadPublicInstitute(pageId);
    const pageObjectId = new Types.ObjectId(pageId);
    const pageHex = pageObjectId.toHexString();

    // DoS backstop: this scan is NOT keyset-paginated (the placement wall shows the
    // whole grouped set), grows with the institute's confirmed-alumni count, and
    // backs a @Public() (anonymous) route. Bound the worst-case read + downstream
    // currentEmployer/companyRefs work with the shared LIST_HARD_CAP (see
    // common/keyset-cursor.ts). An optional client `limit` can only lower the cap,
    // never raise it past the hard ceiling; absent/oversized values fall back to
    // LIST_HARD_CAP. Keep this in sync with getInstituteAlumni's limit+1 bound.
    const scanCap = clampPageSize(opts.limit, LIST_HARD_CAP, LIST_HARD_CAP);

    // Doc-level AND: public + a CONFIRMED, opted-in credential for THIS page (one
    // $elemMatch element, not the cross-product). The placement wall is the
    // confirmed-alumni subset (stricter than the alumni tab, which is any status).
    const rows = await this.profileModel
      .find({
        visibility: 'public',
        training: {
          $elemMatch: {
            companyPageId: pageObjectId,
            confirmStatus: 'confirmed',
            shareWithInstitute: true,
          },
        },
      })
      .select('userId training experience')
      .limit(scanCap)
      .lean<
        Array<{
          userId: Types.ObjectId;
          training?: Array<{
            companyPageId?: unknown;
            confirmStatus?: string;
            shareWithInstitute?: boolean;
          }>;
          experience?: Array<{ companyPageId?: unknown; to?: Date | null; from?: Date | null }>;
        }>
      >()
      .exec();

    // Defence in depth: re-assert each row has a CONFIRMED + opted-in credential
    // for THIS exact page (mirrors the alumni re-check; makes per-page scoping
    // explicit). Rows failing the re-check never count toward totalStudents.
    const students = rows.filter((r) =>
      (r.training ?? []).some(
        (t) =>
          t.confirmStatus === 'confirmed' &&
          t.shareWithInstitute === true &&
          t.companyPageId != null &&
          this.normalizeId(t.companyPageId) === pageHex,
      ),
    );
    if (students.length === 0) {
      return { employers: [], otherEmployerCount: 0, totalStudents: 0 };
    }

    // Per student, derive the CURRENT employer (experience.to == null, most recent
    // by `from`). Bucket distinct students by linked-employer pageId, and a single
    // free-text "other" count for students whose current job has no companyPageId.
    const studentsByEmployerPage = new Map<string, Set<string>>();
    const otherStudents = new Set<string>();
    for (const r of students) {
      const studentId = String(r.userId);
      const current = this.currentEmployer(r.experience);
      if (!current) continue; // no current job: counts in totalStudents only.
      if (current.companyPageId != null && this.normalizeId(current.companyPageId)) {
        const empHex = this.normalizeId(current.companyPageId);
        const set = studentsByEmployerPage.get(empHex) ?? new Set<string>();
        set.add(studentId);
        studentsByEmployerPage.set(empHex, set);
      } else {
        otherStudents.add(studentId);
      }
    }

    // One batched companyRefs lookup over the distinct employer pageIds (no N+1).
    // A hidden / missing employer page drops from the resolved map, so its
    // students fold into the "other workplaces" bucket (no leak of a private page).
    const employerHexes = [...studentsByEmployerPage.keys()];
    const refs = await this.companyRefs(employerHexes);
    const refById = new Map(refs.map((ref) => [ref.id, ref]));

    const employers: InstitutePlacementEmployer[] = [];
    let foldedIntoOther = 0;
    for (const [empHex, studentSet] of studentsByEmployerPage) {
      const company = refById.get(empHex);
      if (company) {
        employers.push({ company, studentCount: studentSet.size });
      } else {
        // The employer page is hidden / gone: its students roll into "other".
        foldedIntoOther += studentSet.size;
      }
    }
    // Sort employers by student count desc (the wall leads with the biggest hirers),
    // tiebroken by name for a stable order.
    employers.sort(
      (a, b) => b.studentCount - a.studentCount || a.company.name.localeCompare(b.company.name),
    );

    return {
      employers,
      otherEmployerCount: otherStudents.size + foldedIntoOther,
      totalStudents: students.length,
    };
  }

  /**
   * Derive a profile's CURRENT employer from its experience[]: the entry with
   * `to == null`/unset (the documented "currently working here" signal), most
   * recent by `from` when several are current. Returns `null` when no entry is
   * current. A missing `from` sorts oldest (an undated current entry loses to a
   * dated one). Pure helper - no DB. Cross-module: the `to == null` convention is
   * the SAME one `ConnectExperienceItem.to` documents.
   */
  private currentEmployer(
    experience:
      | Array<{ companyPageId?: unknown; to?: Date | null; from?: Date | null }>
      | undefined,
  ): { companyPageId?: unknown } | null {
    const current = (experience ?? []).filter((e) => e.to == null);
    if (current.length === 0) return null;
    let best = current[0];
    let bestFrom = best.from ? new Date(best.from).getTime() : -Infinity;
    for (let i = 1; i < current.length; i++) {
      const f = current[i].from ? new Date(current[i].from).getTime() : -Infinity;
      if (f > bestFrom) {
        best = current[i];
        bestFrom = f;
      }
    }
    return best;
  }

  /** Assert the institute seams were wired (by `ConnectInstitutesModule`). */
  private requireInstituteDeps(): InstituteDeps {
    if (!this.instituteDeps) {
      // A misconfiguration (the leaf module did not wire the seams). Treat as a
      // not-found rather than leaking an internal-wiring 500 to the caller.
      throw new NotFoundException('Credential not found');
    }
    return this.instituteDeps;
  }

  /** Normalise an ObjectId | string | unknown id to its hex string ('' if none). */
  private normalizeId(v: unknown): string {
    if (v == null) return '';
    if (v instanceof Types.ObjectId) return v.toHexString();
    if (typeof v === 'string') return v;
    return '';
  }

  /**
   * Validate + stamp the profile's intro video for persistence. Mirrors the
   * marketplace `ListingService.buildOwnedVideos`: every clip `url` AND its
   * optional `posterUrl` must be a file THIS user uploaded (shared media-
   * ownership guard, UploadsModule), then each clip's `durationSec` is set from
   * the SERVER-parsed duration on the owned upload record - never a client claim
   * (the body never carries durationSec). Empty input -> empty result (clears the
   * video on an explicit `videos: []` patch). The 60s length cap is enforced in
   * the upload probe (`connect-profile-video` policy), so an over-cap clip never
   * produces a valid upload record - this path simply trusts the stored duration.
   *
   * `grandfatheredVideos` (update path) exempts a clip already on the profile
   * from the ownership-RECORD check (its url/posterUrl were accepted before this
   * edit); format/host checks still apply to every url.
   */
  private async buildOwnedVideos(
    videos: Array<{ url: string; posterUrl?: string }> | undefined,
    userId: string,
    grandfatheredVideos?: Array<{ url: string; posterUrl?: string }>,
  ): Promise<Array<{ url: string; posterUrl?: string; durationSec?: number }>> {
    if (!videos || videos.length === 0) return [];
    // Flatten clip url + poster url for the batched ownership check (the guard
    // skips empty/undefined slots, so a posterless clip is fine).
    const grandfatheredUrls = (grandfatheredVideos ?? []).flatMap((v) => [v.url, v.posterUrl]);
    const submittedUrls = videos.flatMap((v) => [v.url, v.posterUrl]);
    await this.media.assertOwnedMedia(submittedUrls, userId, { grandfatheredUrls });
    return Promise.all(
      videos.map(async (v) => {
        const durationSec = await this.media.getServerVideoDurationByUrl(v.url, userId);
        return {
          url: v.url,
          ...(v.posterUrl ? { posterUrl: v.posterUrl } : {}),
          ...(durationSec != null ? { durationSec } : {}),
        };
      }),
    );
  }

  /**
   * Emit `connect.profile.changed` for a profile create / content change.
   * Fire-and-forget — the search indexer listens asynchronously. Centralised
   * so the `userId` is normalised to a string exactly once.
   */
  private emitProfileChanged(userId: string | Types.ObjectId): void {
    const payload: ConnectProfileChangedEvent = { userId: String(userId) };
    this.eventEmitter.emit(CONNECT_PROFILE_CHANGED, payload);
  }

  /**
   * Remove a user from Connect public surfaces on account erasure / ban
   * (auth-hardening OQ-3). Flips the `ConnectProfile.visibility` to `hidden`
   * (the strongest non-public state) AND emits `CONNECT_PROFILE_CHANGED`, which
   * the search indexer reacts to by PURGING the person from the `connect_people`
   * Meili index. Without this, an erased/banned user's still-`public` profile
   * stayed findable by every OTHER viewer's search (the JWT layer only blocks
   * the banned user's OWN requests, not their discoverability).
   *
   * Idempotent + best-effort: a no-profile user (never onboarded Connect) is a
   * silent no-op; the event still fires so a stale index doc is cleaned even if
   * the profile row is already gone. Cross-module link: called by
   * `AccountErasureService` (auth) during Bucket-C scrub; consumed by
   * `SearchService.handleProfileChanged`.
   */
  async removeFromConnectForErasure(userId: string | Types.ObjectId): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) return;
    const uid = new Types.ObjectId(userId);
    // Shared "hide the profile from Connect" tail (visibility -> hidden, revoke
    // ERP-verification consent, emit CONNECT_PROFILE_CHANGED so search de-indexes).
    await this.hideProfileAndDeindex(uid);
    // ADR-0004 (ERASURE-ONLY): unlink the ERP workspace on every CompanyPage /
    // Storefront the erased user owns (the entity itself is anonymize-don't-delete,
    // but its ERP trust link must drop). This is NOT part of a content-moderation
    // takedown (which only hides the PROFILE) — it belongs to full account erasure.
    // The erased user's OWNED workspaces are soft-deleted by
    // `softDeleteAllOwnedForErasure`, which cascades to OTHER users' linked
    // entities — so this only needs the erased user's own entities. Best-effort.
    await this.unlinkOwnedErpEntitiesForErasure(uid);
  }

  /**
   * Moderation takedown of a reported profile (CN-MOD-1, feed harden Bucket 6).
   *
   * The `content-reports` module's admin "Remove" action emits
   * CONTENT_TAKEDOWN_EVENT; the profile module owns the reaction for its own
   * `targetType`, exactly like feed.service (post) + listing-moderation (listing)
   * + comment.service (comment) do (shared abstraction #3 — reuse the existing
   * dispatch pattern). Per owner decision OQ-3 (2026-07-02): "Remove" HIDES the
   * profile from Connect ONLY (visibility flip + de-index + ERP-consent revoke via
   * the shared `hideProfileAndDeindex` tail). It does NOT touch `User.isActive` —
   * suspending the whole account is the platform admin's separate, heavier
   * "Suspend user" action. The admin already audits the report action in
   * content-reports.service, so no extra audit here. Idempotent (a re-fire just
   * re-hides an already-hidden profile).
   *
   * Cross-module: listens to CONTENT_TAKEDOWN_EVENT (content-reports.constants);
   * emits CONNECT_PROFILE_CHANGED (consumed by the search indexer).
   */
  @OnEvent(CONTENT_TAKEDOWN_EVENT)
  async onContentTakedown(e: ContentTakedownEvent): Promise<void> {
    if (e.targetType !== 'profile') return;
    // A profile report's targetId is the reported user's id (per the report schema).
    if (!Types.ObjectId.isValid(e.targetId)) return;
    await this.hideProfileAndDeindex(new Types.ObjectId(e.targetId));
  }

  /**
   * Shared "hide this profile from Connect" tail used by BOTH the full-erasure
   * path and the moderation-takedown handler, so the two can never drift on what
   * "hidden from Connect" means. Flips `visibility` to `hidden` (so every
   * `visibility:'public'` read path — search hydration, /u/[id], people lookups —
   * drops the profile), revokes ERP-verification consent (badge off), and signals
   * the search indexer to purge the person. `updateOne` is a no-op when no profile
   * exists; the emit still fires so a stale index doc is removed defensively. Does
   * NOT unlink owned ERP entities — that is an erasure-only side effect (see
   * removeFromConnectForErasure).
   */
  private async hideProfileAndDeindex(uid: Types.ObjectId): Promise<void> {
    await this.profileModel
      .updateOne(
        { userId: uid },
        {
          $set: {
            visibility: 'hidden',
            'erpVerificationConsent.status': 'revoked',
            'erpVerificationConsent.grantedAt': null,
            'erpVerificationConsent.revokedAt': new Date(),
          },
        },
      )
      .exec();
    this.emitProfileChanged(uid);
  }

  /**
   * Revoke the ERP link on every CompanyPage / Storefront owned by the erased
   * user (ADR-0004 account-erasure cleanup). Clears `erpWorkspaceId` + marks
   * `erpLink.status: 'revoked'` so the entity reads as not-verified. Best-effort:
   * swallows its own faults (the erasure write must not be blocked by a Connect
   * side effect). No-op when a model is absent (unit tests / degraded boot).
   */
  private async unlinkOwnedErpEntitiesForErasure(ownerUserId: Types.ObjectId): Promise<void> {
    const revoke = {
      $set: {
        erpWorkspaceId: null,
        'erpLink.status': 'revoked',
        'erpLink.linkedAt': null,
      },
    };
    try {
      await Promise.all([
        this.companyPageModel
          ?.updateMany({ ownerUserId, erpWorkspaceId: { $ne: null } }, revoke)
          .exec(),
        this.storefrontModel
          ?.updateMany({ ownerUserId, erpWorkspaceId: { $ne: null } }, revoke)
          .exec(),
      ]);
    } catch {
      // Best-effort: ERP-link cleanup is a side effect of erasure; the entities
      // are already being hidden/anonymized elsewhere and the derive-live decay
      // is the backstop. Do not rethrow into the erasure flow.
    }
  }

  /**
   * Reversible Scope-1 "delete Connect" soft phase (ACCOUNT-DELETION-AND-DPDP-PLAN.md
   * §3A). Snapshots the profile's CURRENT visibility into `preDeletionVisibility`
   * (so admin-mediated recovery can restore the exact prior level — a
   * `connections`-only profile must not come back `public`), then runs the SAME
   * hide + de-index + ERP-consent-revoke + entity-unlink as
   * {@link removeFromConnectForErasure}. Content is hidden, not destroyed → clean
   * recovery until the Day-30 {@link ConnectContentPurgeService} hard-deletes it.
   *
   * Idempotent: a re-run never overwrites a real snapshot with `hidden` (the
   * snapshot is taken only while the profile is not already hidden + unset).
   */
  async hideForConnectDeletion(userId: string | Types.ObjectId): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) return;
    const uid = new Types.ObjectId(userId);
    const prof = await this.profileModel
      .findOne({ userId: uid })
      .select('visibility preDeletionVisibility')
      .lean<{ visibility?: string; preDeletionVisibility?: string | null }>()
      .exec();
    if (prof && prof.visibility !== 'hidden' && prof.preDeletionVisibility == null) {
      await this.profileModel
        .updateOne({ userId: uid }, { $set: { preDeletionVisibility: prof.visibility } })
        .exec();
    }
    await this.removeFromConnectForErasure(uid);
  }

  /**
   * Admin-mediated Scope-1 recovery (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3A) — the
   * mirror of {@link hideForConnectDeletion}. Restores the snapshotted prior
   * visibility (defaulting to `public` if none was captured), clears the
   * snapshot, and re-indexes (content was only hidden, never destroyed, while the
   * 30-day window was open). The ERP-verify consent + entity ERP links revoked at
   * hide time are NOT auto-restored — the user re-grants those (matches §3A: "un-
   * hide ... re-index").
   */
  async unhideForConnectRecovery(userId: string | Types.ObjectId): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) return;
    const uid = new Types.ObjectId(userId);
    const prof = await this.profileModel
      .findOne({ userId: uid })
      .select('preDeletionVisibility')
      .lean<{ preDeletionVisibility?: string | null }>()
      .exec();
    const restore =
      (prof?.preDeletionVisibility as ConnectProfileVisibility | undefined) ?? 'public';
    await this.profileModel
      .updateOne(
        { userId: uid },
        { $set: { visibility: restore }, $unset: { preDeletionVisibility: '' } },
      )
      .exec();
    // Re-index — the people indexer re-reads visibility and re-adds a now-public profile.
    this.emitProfileChanged(uid);
  }

  /**
   * Event hook (OQ-3) — when Auth erases / bans an account, hide the user from
   * public Connect surfaces and de-index them from search. `async: true` so a
   * slow Meili write never blocks the erasure thread; `removeFromConnectForErasure`
   * swallows its own faults (Mongo update + fire-and-forget emit), so this
   * listener cannot throw back into the bus.
   */
  @OnEvent(ACCOUNT_ERASED, { async: true })
  async handleAccountErased(payload: AccountErasedEvent): Promise<void> {
    await this.removeFromConnectForErasure(payload.userId);
  }

  /**
   * Emit `connect.profile.created` ONCE, on the first lazy ConnectProfile create
   * (Institutes Phase 2, Feature 5). The institutes referral handler listens to
   * stamp first-touch attribution. Fire-and-forget + wrapped: a synchronous
   * listener throw (EventEmitter2 emit is synchronous) must never propagate back
   * into the profile create, so the emit is guarded. Centralised so the `userId`
   * is normalised to a string exactly once. Keep in sync with the
   * InstituteReferralService consumer of CONNECT_PROFILE_CREATED.
   */
  private emitProfileCreated(userId: string | Types.ObjectId): void {
    try {
      const payload: ConnectProfileCreatedEvent = { userId: String(userId) };
      this.eventEmitter.emit(CONNECT_PROFILE_CREATED, payload);
    } catch {
      // Best-effort: attribution is a non-critical side effect of onboarding.
    }
  }

  /**
   * Batch person lookup — resolves a set of `User` ids to their viewer-facing
   * identity (`name` + `avatar` from `User`, `headline` from `ConnectProfile`)
   * in two indexed `$in` queries. Backs the network / suggestions / search
   * people cards without an N+1. Invalid ids are dropped; `hidden`-visibility
   * profiles contribute no headline. Order is not guaranteed — callers map by
   * `userId`.
   */
  async getPeopleByIds(ids: string[]): Promise<ConnectPersonRef[]> {
    const objectIds = [...new Set(ids)]
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return [];

    const [users, profiles] = await Promise.all([
      this.userModel
        .find({ _id: { $in: objectIds } })
        // isDemo marks seeded demo/sample accounts so the FE can show a "Sample"
        // tag and the suggestion ranker can down-rank demo (drives the chip via
        // ConnectPersonRef). See DEMO-CONTENT-TRUST-UX-PLAN.md (Phase 1).
        .select('name profilePicture isDemo')
        .lean<
          Array<{ _id: Types.ObjectId; name?: string; profilePicture?: string; isDemo?: boolean }>
        >()
        .exec(),
      this.profileModel
        // openTo / openToDetails feed the derived "open to" avatar ring.
        .find({ userId: { $in: objectIds }, visibility: { $ne: 'hidden' } })
        .select('userId headline openTo openToDetails')
        .lean<
          Array<{
            userId: Types.ObjectId;
            headline?: string;
            openTo?: { work?: boolean; hiring?: boolean };
            openToDetails?: {
              work?: { audience?: string };
              hiring?: { audience?: string };
            };
          }>
        >()
        .exec(),
    ]);

    const headlineByUser = new Map(
      profiles.map((p) => [String(p.userId), p.headline?.trim() || null]),
    );
    // Pre-derive each person's traveling "open to" status once (network-scoped
    // intents resolve to null here so they do not leak into broad lists).
    const openStatusByUser = new Map(
      profiles.map((p) => [String(p.userId), deriveOpenStatus(p.openTo, p.openToDetails)]),
    );
    // CN-SRCH-1 (feed harden Bucket 5): return in the CALLER's supplied `ids`
    // order, not Mongo's natural ($in) order. Search verticals pass Meili
    // relevance-ranked ids; before this, people search silently re-sorted them
    // to insertion order (an exact-name match could sink below older rows). A
    // by-id lookup honouring caller order is the intuitive contract and fixes
    // every caller (getSuggestions already re-pinned after this call — now
    // redundant but harmless). Build a byId map, then map over the input ids.
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return ids
      .map((id) => byId.get(String(id)))
      .filter((u): u is (typeof users)[number] => u !== undefined)
      .map((u) => ({
        userId: String(u._id),
        name: u.name ?? '',
        avatar: u.profilePicture ?? null,
        headline: headlineByUser.get(String(u._id)) ?? null,
        // Default null when the person has no (visible) profile row.
        openStatus: openStatusByUser.get(String(u._id)) ?? null,
        isDemo: u.isDemo === true,
      }));
  }

  /**
   * Public-safe batch person lookup -- the logged-out counterpart of
   * `getPeopleByIds`. Resolves ids to identity ONLY for users who have a
   * `public`-visibility Connect profile, so an anonymous caller can never
   * enumerate arbitrary `User` ids into names/avatars (ERP-only accounts and
   * hidden / connections-only profiles contribute NOTHING). Backs the public
   * profile activity author hydration (feed `getPublicActivity` -> web
   * `getPublicPeople`). A repost whose original author is not public simply
   * resolves to no author, which the card renders without a name.
   *
   * Cross-module: read by the Feed module's public activity path. Keep the
   * returned `ConnectPersonRef` shape identical to `getPeopleByIds` so the web
   * hydration map is interchangeable.
   */
  async getPublicPeopleByIds(ids: string[]): Promise<ConnectPersonRef[]> {
    const objectIds = [...new Set(ids)]
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return [];

    // Public profiles are the source of truth for WHO is resolvable here -- we
    // start from the profile rows (visibility: 'public') and only then fetch
    // the matching User identities. This inner-join shape is what keeps a
    // non-public / ERP-only user out of the result entirely.
    const profiles = await this.profileModel
      .find({ userId: { $in: objectIds }, visibility: 'public' })
      .select('userId headline openTo openToDetails')
      .lean<
        Array<{
          userId: Types.ObjectId;
          headline?: string;
          openTo?: { work?: boolean; hiring?: boolean };
          openToDetails?: {
            work?: { audience?: string };
            hiring?: { audience?: string };
          };
        }>
      >()
      .exec();
    if (profiles.length === 0) return [];

    const publicUserIds = profiles.map((p) => p.userId);
    const users = await this.userModel
      .find({ _id: { $in: publicUserIds } })
      // isDemo: keep parity with getPeopleByIds so public activity authors badge too.
      .select('name profilePicture isDemo')
      .lean<
        Array<{ _id: Types.ObjectId; name?: string; profilePicture?: string; isDemo?: boolean }>
      >()
      .exec();

    const headlineByUser = new Map(
      profiles.map((p) => [String(p.userId), p.headline?.trim() || null]),
    );
    const openStatusByUser = new Map(
      profiles.map((p) => [String(p.userId), deriveOpenStatus(p.openTo, p.openToDetails)]),
    );
    return users.map((u) => ({
      userId: String(u._id),
      name: u.name ?? '',
      avatar: u.profilePicture ?? null,
      headline: headlineByUser.get(String(u._id)) ?? null,
      openStatus: openStatusByUser.get(String(u._id)) ?? null,
      isDemo: u.isDemo === true,
    }));
  }

  /**
   * A user's feed-ranking signals — skills + the "open to" intent toggles —
   * read WITHOUT lazily creating a profile (a feed read must never mint one).
   * Returns empty / all-false defaults when the user has no profile yet, so
   * the caller (`FeedService` ranker) needs no null-handling.
   */
  async getRankingSignals(userId: string | Types.ObjectId): Promise<RankingSignals> {
    // isDemo lives on User (not ConnectProfile), so fetch it alongside the
    // profile signals — this is the author lookup that the feed's createPost
    // already calls, so denormalizing Post.isDemo here adds no extra round-trip
    // to that path beyond this thin User read.
    const [profile, user] = await Promise.all([
      this.profileModel
        .findOne({ userId: new Types.ObjectId(userId) })
        .select('skills openTo district')
        .lean<{ skills?: string[]; openTo?: ConnectOpenTo; district?: string }>()
        .exec(),
      this.userModel
        .findById(new Types.ObjectId(userId))
        .select('isDemo')
        .lean<{ isDemo?: boolean }>()
        .exec(),
    ]);
    return {
      skills: profile?.skills ?? [],
      openTo: profile?.openTo ?? { work: false, hiring: false, deals: false, customOrders: false },
      district: profile?.district ?? '',
      isDemo: user?.isDemo === true,
    };
  }
}
