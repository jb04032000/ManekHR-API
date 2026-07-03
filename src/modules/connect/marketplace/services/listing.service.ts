import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types, type FilterQuery } from 'mongoose';
import {
  Listing,
  NEW_SERVICE_CATEGORIES,
  type ListingDocument,
  type ListingCourseFeeType,
  type ListingCourseMode,
  type ListingPriceType,
  type ListingServiceDeliveryMode,
  type ListingServicePricingModel,
  type ListingUnit,
} from '../schemas/listing.schema';
import { Inquiry, type InquiryDocument } from '../schemas/inquiry.schema';
import { User } from '../../../users/schemas/user.schema';
import { LIST_HARD_CAP } from '../../common/keyset-cursor';
import { ConnectAllowanceService } from '../../monetization/connect-allowance.service';
import { ConnectOverLimitService } from '../../over-limit/connect-over-limit.service';
import { ReviewService, type RatingAggregate } from '../../reviews/review.service';
import { StorefrontService } from '../../entities/services/storefront.service';
import {
  toListingRef,
  type ConnectListingRef,
  type ListingForRef,
} from '../../search/listing-search.helpers';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { TagService } from '../../tags/tag.service';
import {
  CONNECT_LISTING_CHANGED,
  type ConnectListingChangedEvent,
} from '../events/connect-listing.events';
import { MediaOwnershipService } from '../../../uploads/services/media-ownership.service';
import { env } from '../../../../config/env';
// CN-LIM-3: serialize the count-cap check+insert per owner so two parallel
// creates at limit-1 can't both pass the check and land at limit+1. Reuses the
// shared Redis mutex used elsewhere for exactly this check-then-act TOCTOU class
// (see SingleFlightService.withLock docstring) — not a new locking primitive.
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { connectCapLockKey } from '../../over-limit/connect-cap-lock.util';
// Single source of truth for slot-occupying statuses, shared with the
// over-limit reconciler (connect-over-limit.service.ts) so "create counts" and
// "used counts" can never drift.
import { LISTING_SLOT_STATUSES } from '../marketplace.constants';

// Slot statuses are now a single exported constant shared with the over-limit
// reconciler (see marketplace.constants.ts). Local alias keeps the call sites
// below unchanged. `[...]` copies to a plain string[] so existing
// `$in: SLOT_STATUSES` / `.includes()` usages keep their prior runtime type.
const SLOT_STATUSES: string[] = [...LISTING_SLOT_STATUSES];

// The 8 NEW service categories (Slice B1). A create persists `serviceDetails`
// only when the resolved category is one of these — mirrors the
// `resolvedCategory === 'course'` gate for `courseDetails`. Plain string[] so the
// `.includes()` check matches the open-string `category` value.
const NEW_SERVICE_CATEGORY_SET: string[] = [...NEW_SERVICE_CATEGORIES];

/**
 * Listing moderation switch. While DISABLED (current product decision), a new
 * listing publishes LIVE immediately (active + approved) with no admin review,
 * edits do not re-submit, and publish goes straight to active. Flip to `true` to
 * re-introduce the review flow - the admin moderation queue, the status /
 * moderationStatus axes, and every gate query stay in place, just dormant while
 * this is off.
 *
 * The value now lives in the env/config system (CONNECT_LISTING_MODERATION_ENABLED,
 * default false) so it can flip per environment without a code change. Read once at
 * module load like every other `env.*` flag; a deploy-time toggle never needs a
 * hot re-read. See env.ts `connectMarketplace.moderationEnabled`.
 */
const LISTING_MODERATION_ENABLED = env.connectMarketplace.moderationEnabled;

/**
 * Editable content fields a seller may patch via update(). `category` and
 * `tags` are intentionally excluded: both go through TagService.normalizeHashtags
 * for alias folding + slug creation and are handled explicitly before this loop.
 */
const EDITABLE_FIELDS = [
  'title',
  'description',
  'priceType',
  'priceMin',
  'priceMax',
  'unit',
  'moq',
  'leadTimeDays',
  'location',
  'images',
  'specs',
  'tradeTerms',
  'courseDetails',
  'serviceDetails',
] as const;

export interface ListingLocationInput {
  district?: string;
  city?: string;
  state?: string;
}

export interface CreateListingInput {
  title: string;
  description?: string;
  /**
   * Raw category term from the seller. May be one of the 8 known
   * LISTING_CATEGORIES slugs or any custom term. The service normalises it
   * via TagService (same as `tags`) before persisting.
   */
  category: string;
  priceType?: ListingPriceType;
  priceMin?: number | null;
  priceMax?: number | null;
  unit?: ListingUnit;
  moq?: number | null;
  leadTimeDays?: number | null;
  location?: ListingLocationInput;
  images?: string[];
  /**
   * Product video(s), capped at one (DTO `@ArrayMaxSize(1)`). `url` + optional
   * `posterUrl` are client-uploaded; `durationSec` is server-derived from the
   * owned upload record (a client value here is ignored). Mirrors the feed video
   * media item.
   */
  videos?: Array<{ url: string; posterUrl?: string }>;
  /** Raw seller-entered terms; the service resolves them to canonical slugs. */
  tags?: string[];
  /** Specification rows (label/value) for the detail-page spec grid. */
  specs?: Array<{ label: string; value: string }>;
  /** Off-platform trade terms shown on the detail-page rail. */
  tradeTerms?: { dispatch?: string; payment?: string; returns?: string };
  /**
   * Course detail (Institutes Phase 1). Present only on a `category === 'course'`
   * listing; the DTO requires its core fields when the category is `course`. The
   * fee reuses `priceMin` / `priceMax` (driven by `feeType`).
   */
  courseDetails?: {
    durationLabel: string;
    batchStart?: string | Date | null;
    mode: ListingCourseMode;
    feeType: ListingCourseFeeType;
    seats?: number | null;
    certificate?: boolean;
    skillsTaught?: string[];
  };
  /**
   * Service detail (Slice B1). Present only on a listing whose category is one of
   * the 8 NEW_SERVICE_CATEGORIES; the DTO requires its core fields then. The fee
   * reuses `priceMin` / `priceMax` (driven by `pricingModel`), like courseDetails.
   */
  serviceDetails?: {
    deliveryMode: ListingServiceDeliveryMode;
    pricingModel: ListingServicePricingModel;
    coverageArea?: string;
    yearsExperience?: number | null;
    availability?: string;
  };
  /**
   * The storefront to list under. Optional: when omitted the listing goes to
   * the owner's default storefront (created on first use). When provided it is
   * verified to be owned by the caller.
   */
  storefrontId?: string;
  /** Save off-market as a `draft` instead of going live on create. */
  asDraft?: boolean;
}

export type UpdateListingInput = Partial<CreateListingInput>;

/**
 * Per-storefront roll-up for the owner's Storefronts dashboard. One entry per
 * storefront the owner has at least one listing in.
 */
export interface StorefrontStats {
  storefrontId: string;
  /** Total listings under this storefront (any status). */
  products: number;
  /** Listings that are publicly live == buyer-visible: status `active` AND
   *  moderation `approved` AND a cover photo (the public store grid's gate). */
  live: number;
  /** Inquiries received across all of this storefront's listings. */
  inquiries: number;
}

/**
 * ManekHR Connect Marketplace -- listing CRUD (Phase M1.2).
 *
 * PERSON-CENTRIC: every write derives the owner from the JWT (`ownerUserId`),
 * never from the request body, and ownership is verified on every mutation so
 * one person can never touch another's listing. create() is gated on
 * `ConnectAllowanceService.assertCanCreateListing` (numeric cap with a
 * connect_free fallback) BEFORE persisting -- a soft cap that throws 403, never
 * a hard subscription wall (free users must still be able to list).
 */
@Injectable()
export class ListingService {
  private readonly logger = new Logger(ListingService.name);

  constructor(
    @InjectModel(Listing.name)
    private readonly listingModel: Model<ListingDocument>,
    @InjectModel(Inquiry.name)
    private readonly inquiryModel: Model<InquiryDocument>,
    private readonly allowances: ConnectAllowanceService,
    private readonly storefronts: StorefrontService,
    private readonly audit: AuditService,
    private readonly eventEmitter: EventEmitter2,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    private readonly tagService: TagService,
    /** Seller rating aggregate folded onto public listing reads (R2). */
    private readonly reviews?: ReviewService,
    /**
     * Seller's join date folded onto the public detail read ("On ManekHR
     * since ..."). LAST + @Optional so positional unit-test mocks don't shift.
     */
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<User>,
    /**
     * Shared media-URL ownership guard (uploads module). Verifies the caller
     * actually uploaded each listing image before it is persisted. @Optional so
     * positional unit-test constructors keep working; production DI injects it.
     */
    @Optional() private readonly media?: MediaOwnershipService,
    /**
     * Over-limit suppression (grandfathering). Computes the read-time suppressed
     * id set for the owner under the `hide_newest` policy; a no-op under the
     * default `freeze` policy. @Optional + LAST so positional unit-test
     * constructors keep working (when absent, nothing is suppressed). See
     * docs/connect/2026-06-12-connect-over-limit-policy.md.
     */
    @Optional() private readonly overLimit?: ConnectOverLimitService,
    /**
     * CN-LIM-3: shared Redis mutex used to serialize the create-cap check+insert
     * per owner (closes the two-parallel-creates-at-limit-1 race). @Optional + LAST
     * so positional unit-test constructors keep working; when absent the critical
     * section runs inline exactly as before (unit tests are single-threaded, so
     * the lock is a production-concurrency concern, not a test concern). Provided
     * globally by SchedulerModule (@Global).
     */
    @Optional() private readonly capLock?: SingleFlightService,
  ) {}

  // NOTE: the "release listings stranded in review when moderation is off"
  // backfill used to run here on EVERY boot (OnModuleInit). It now runs via the
  // ledgered migration runner (ADR-0001) — `src/migrations/backfill-listing-moderation.ts`.
  // Do NOT re-add a boot hook here on merge (that's the Finding 3 pattern we removed).

  /**
   * Fire-and-forget the listing-changed event so the search indexer (M1.4)
   * can keep `connect_listings` warm. Wrapping the emit keeps each lifecycle
   * site to a single line + makes the signal trivially mockable in tests.
   */
  private emitChanged(listingId: string | Types.ObjectId): void {
    const payload: ConnectListingChangedEvent = { listingId: String(listingId) };
    this.eventEmitter.emit(CONNECT_LISTING_CHANGED, payload);
  }

  /**
   * CN-LIM-3: run `fn` while holding the per-owner listing-cap mutex so a
   * count-check+insert can't race a sibling create. Runs inline (no lock) when
   * the SingleFlightService isn't injected (positional unit-test constructors) —
   * unit tests are single-threaded, so the lock is a production concern only.
   */
  private async withCapLock<T>(ownerUserId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.capLock) return fn();
    return this.capLock.withLock(connectCapLockKey('listing', ownerUserId), fn);
  }

  /**
   * Create a listing for the authenticated person. Counts the owner's
   * slot-occupying listings, asserts the cap (throws 403 at the limit), then
   * persists the listing. Moderation is off, so it is born live
   * (`active` / `approved`); flip LISTING_MODERATION_ENABLED to queue it instead.
   *
   * CN-LIM-3: the count → assert → insert is done under a per-owner mutex
   * (`withCapLock`) so two parallel creates at limit-1 can't both pass the check
   * and land at limit+1 — the second waits, re-counts the now-incremented total,
   * and is correctly rejected. The heavy pre-persist resolution (media ownership,
   * video stamping, storefront, tags, category, isDemo) stays OUTSIDE the lock so
   * the critical section held is a single count + insert (sub-ms), never a media
   * round-trip.
   */
  async create(ownerUserId: string, input: CreateListingInput): Promise<ListingDocument> {
    // Ownership-check every attached image BEFORE persisting via the shared
    // media-ownership guard (uploads module): each url must be on our storage
    // AND uploaded by this caller, so one seller can never attach another's file.
    await this.media.assertOwnedMedia(input.images ?? [], ownerUserId);

    // Product video(s): same ownership guard on url + posterUrl, plus the
    // server-derived duration stamped on each clip (see buildOwnedVideos). Empty
    // when none submitted, so a video-less listing is unchanged.
    const videos = await this.buildOwnedVideos(input.videos, ownerUserId);

    // Products belong to a storefront. Use the chosen one (verified owned, 404
    // otherwise) or the owner's default storefront (created on first use). The
    // cap above stays person-centric by ownerUserId -- the storefront is purely
    // an additive grouping axis.
    const storefront = input.storefrontId
      ? await this.storefronts.getMine(ownerUserId, input.storefrontId)
      : await this.storefronts.getOrCreateDefaultStorefront(ownerUserId);

    const tagSlugs = input.tags?.length ? await this.tagService.normalizeHashtags(input.tags) : [];
    if (tagSlugs.length) {
      void this.tagService.recordUsage(tagSlugs, ownerUserId);
    }

    // Resolve category through the same tag engine as `tags` so a custom
    // category self-registers and stays canonical. Fall back to a simple
    // trim+lowercase when normalizeHashtags returns nothing (should not
    // happen for a non-empty string, but defensive).
    const [categorySlug] = await this.tagService.normalizeHashtags([input.category]);
    const resolvedCategory = categorySlug ?? input.category.trim().toLowerCase();
    if (categorySlug) {
      void this.tagService.recordUsage([categorySlug], ownerUserId);
    }

    // Denormalize the "sample/demo content" marker from the owner's User.isDemo at
    // create time (mirrors Post.authorErpLinked in feed.service.ts) so the web
    // "Sample" badge + the search down-rank read one stamped source, never join.
    // Defaults false when the user lookup is unavailable (positional unit mocks).
    const owner = await this.userModel
      ?.findById(ownerUserId)
      .select('isDemo')
      .lean<{ isDemo?: boolean }>()
      .exec();
    const isDemo = owner?.isDemo === true;

    // CN-LIM-3 critical section: (re-)count the owner's slot-occupying listings,
    // assert the cap, and insert — all while holding the per-owner mutex. Counting
    // INSIDE the lock (not once up-front) is what closes the race: a second
    // concurrent create blocks here, then re-reads the incremented count and is
    // rejected at the cap instead of also inserting.
    const listing = await this.withCapLock(ownerUserId, async () => {
      const currentCount = await this.listingModel.countDocuments({
        ownerUserId: new Types.ObjectId(ownerUserId),
        status: { $in: SLOT_STATUSES },
      });
      await this.allowances.assertCanCreateListing(ownerUserId, currentCount);

      return (await this.listingModel.create({
        ownerUserId: new Types.ObjectId(ownerUserId),
        storefrontId: storefront._id,
        title: input.title,
        description: input.description ?? '',
        category: resolvedCategory,
        priceType: input.priceType ?? 'negotiable',
        priceMin: input.priceMin ?? null,
        priceMax: input.priceMax ?? null,
        unit: input.unit,
        moq: input.moq ?? null,
        leadTimeDays: input.leadTimeDays ?? null,
        location: input.location ?? {},
        images: input.images ?? [],
        videos,
        tags: tagSlugs,
        specs: input.specs ?? [],
        tradeTerms: input.tradeTerms ?? {},
        // Course detail only on a course listing; null otherwise (additive default).
        courseDetails: resolvedCategory === 'course' ? (input.courseDetails ?? null) : null,
        // Service detail only on a service listing (one of the 8 NEW_SERVICE_CATEGORIES);
        // null otherwise (additive default — mirrors courseDetails).
        serviceDetails: NEW_SERVICE_CATEGORY_SET.includes(resolvedCategory)
          ? (input.serviceDetails ?? null)
          : null,
        // Moderation off -> live immediately; on -> queued for admin review.
        // Save-as-draft keeps it off-market (the seller publishes later); otherwise
        // it goes live (or to review when moderation is on). moderationStatus is
        // unchanged by draft, so publishing a draft later makes it live with no
        // re-approval when moderation is off.
        status: input.asDraft ? 'draft' : LISTING_MODERATION_ENABLED ? 'pending_review' : 'active',
        moderationStatus: LISTING_MODERATION_ENABLED ? 'pending' : 'approved',
        // Denormalized sample-content marker, stamped from the owner's User.isDemo.
        isDemo,
      })) as ListingDocument;
    });

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Listing',
      entityId: String(listing._id),
      action: 'listing_created',
      actorId: ownerUserId,
      meta: { category: resolvedCategory },
    });
    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'connect.listing_created',
      properties: { listingId: String(listing._id), category: resolvedCategory },
    });
    this.emitChanged(listing._id);

    return listing;
  }

  /**
   * Patch a listing's content (owner-only). Editing a previously-approved
   * listing sends it back to review so changed content is re-checked before it
   * stays publicly discoverable.
   */
  async update(
    id: string,
    ownerUserId: string,
    patch: UpdateListingInput,
  ): Promise<ListingDocument> {
    const listing = await this.loadOwned(id, ownerUserId);

    // When images are being replaced, ownership-check the new set via the shared
    // media-ownership guard (uploads module). The listing's existing images are
    // grandfathered (they predate ownership tracking / were already accepted),
    // so only newly-added urls need an ownership record.
    if (patch.images !== undefined) {
      await this.media.assertOwnedMedia(patch.images, ownerUserId, {
        grandfatheredUrls: listing.images,
      });
    }

    // Videos are stamped (server duration) + ownership-checked here, NOT in the
    // generic field loop. The listing's existing video is grandfathered (its
    // url/posterUrl predate this edit), so only a newly-added clip needs an
    // ownership record. An omitted `videos` leaves the existing one untouched.
    if (patch.videos !== undefined) {
      const built = await this.buildOwnedVideos(patch.videos, ownerUserId, listing.videos);
      (listing as unknown as Record<string, unknown>).videos = built;
    }

    // Resolve tags + category explicitly before the generic field-copy loop.
    // Both must go through normalizeHashtags (alias folding + slug creation)
    // so they are intentionally excluded from EDITABLE_FIELDS.
    if (patch.tags !== undefined) {
      const slugs = patch.tags.length ? await this.tagService.normalizeHashtags(patch.tags) : [];
      if (slugs.length) void this.tagService.recordUsage(slugs, ownerUserId);
      (listing as unknown as Record<string, unknown>).tags = slugs;
    }

    if (patch.category !== undefined) {
      const [categorySlug] = await this.tagService.normalizeHashtags([patch.category]);
      const resolvedCategory = categorySlug ?? patch.category.trim().toLowerCase();
      if (categorySlug) void this.tagService.recordUsage([categorySlug], ownerUserId);
      (listing as unknown as Record<string, unknown>).category = resolvedCategory;
    }

    const src = patch as Record<string, unknown>;
    const dst = listing as unknown as Record<string, unknown>;
    for (const key of EDITABLE_FIELDS) {
      if (src[key] !== undefined) {
        dst[key] = src[key];
      }
    }

    // Re-submit a live listing for review only while moderation is enabled;
    // with it off, edits stay live (no re-review).
    if (LISTING_MODERATION_ENABLED && listing.moderationStatus === 'approved') {
      listing.moderationStatus = 'pending';
      listing.status = 'pending_review';
    }

    await listing.save();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Listing',
      entityId: String(listing._id),
      action: 'listing_updated',
      actorId: ownerUserId,
    });
    this.emitChanged(listing._id);
    return listing;
  }

  /**
   * Publish a listing (owner-only). Moderation is off, so it goes live
   * (`active`) immediately; with moderation on, an unapproved listing would be
   * submitted for review (`pending_review`) instead.
   */
  async publish(id: string, ownerUserId: string): Promise<ListingDocument> {
    const listing = await this.loadOwned(id, ownerUserId);
    // CN-MOD-3 (feed harden Bucket 10): a moderation TAKEDOWN sets both `status`
    // and `moderationStatus` to `rejected`. Republish previously flipped `status`
    // back to `active` but NEVER cleared `moderationStatus:'rejected'`, so the
    // listing became permanently invisible (every read gates on
    // moderationStatus==='approved') while consuming a plan slot AND reporting
    // success to the seller — the publish button silently lied. Block it with an
    // honest error instead (option a). An appeal/re-review flow is a separate
    // future feature, not implied by this bug.
    if (listing.moderationStatus === 'rejected') {
      throw new BadRequestException(
        'This listing was removed by moderation and cannot be republished. Please create a new listing.',
      );
    }
    // Moderation off -> always live; on -> live only once approved.
    const nextStatus =
      !LISTING_MODERATION_ENABLED || listing.moderationStatus === 'approved'
        ? 'active'
        : 'pending_review';
    // Reactivation gate (limit-enforcement): publishing a listing whose CURRENT
    // status occupies no slot (expired / rejected) back into a slot-occupying
    // status is creation-equivalent toward maxListings, so re-check the cap here
    // (counting the owner's OTHER slot listings). Publishing something already in
    // a slot (draft / paused) never increases the count, so it is never gated.
    // assertCanCreateListing is itself a no-op when CONNECT_LIMITS_ENFORCED=false.
    const wasInSlot = SLOT_STATUSES.includes(listing.status);
    if (!wasInSlot && SLOT_STATUSES.includes(nextStatus)) {
      const slotCount = await this.listingModel.countDocuments({
        ownerUserId: new Types.ObjectId(ownerUserId),
        status: { $in: SLOT_STATUSES },
        _id: { $ne: listing._id },
      });
      await this.allowances.assertCanCreateListing(ownerUserId, slotCount);
    }
    listing.status = nextStatus;
    await listing.save();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Listing',
      entityId: String(listing._id),
      action: 'listing_published',
      actorId: ownerUserId,
    });
    this.emitChanged(listing._id);
    return listing;
  }

  /** Pause an active listing (owner-only). No-op when not active. */
  async pause(id: string, ownerUserId: string): Promise<ListingDocument> {
    const listing = await this.loadOwned(id, ownerUserId);
    if (listing.status === 'active') {
      listing.status = 'paused';
      await listing.save();
      await this.audit.logEvent({
        module: AppModule.CONNECT,
        entityType: 'Listing',
        entityId: String(listing._id),
        action: 'listing_paused',
        actorId: ownerUserId,
      });
      this.emitChanged(listing._id);
    }
    return listing;
  }

  /** Hard-delete a listing (owner-only). */
  async remove(id: string, ownerUserId: string): Promise<{ deleted: boolean; id: string }> {
    const listing = await this.loadOwned(id, ownerUserId);
    await this.listingModel.deleteOne({ _id: listing._id });
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Listing',
      entityId: String(listing._id),
      action: 'listing_deleted',
      actorId: ownerUserId,
    });
    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'connect.listing_deleted',
      properties: { listingId: String(listing._id) },
    });
    // Emit AFTER the delete so the indexer fetches and finds the listing gone,
    // then purges it from the index (the missing-row branch in indexListing).
    this.emitChanged(listing._id);
    return { deleted: true, id: String(listing._id) };
  }

  /**
   * The caller's own listings (any status), newest first. Optionally scoped to
   * one of the caller's storefronts -- the storefront manage page is the
   * per-shop product home, so it passes `storefrontId` to manage just that
   * shop's products; an omitted id returns all of the owner's listings flat.
   * Ownership is always pinned by `ownerUserId`, so a storefrontId the caller
   * does not own simply yields none (never another owner's products).
   */
  async listMine(
    ownerUserId: string,
    storefrontId?: string,
  ): Promise<Array<Listing & { suppressed?: boolean }>> {
    const filter: FilterQuery<ListingDocument> = {
      ownerUserId: new Types.ObjectId(ownerUserId),
    };
    if (storefrontId && Types.ObjectId.isValid(storefrontId)) {
      filter.storefrontId = new Types.ObjectId(storefrontId);
    }
    const listings = await this.listingModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean<Array<Listing & { _id: Types.ObjectId; suppressed?: boolean }>>()
      .exec();
    // Stamp the over-limit `suppressed` flag (hide_newest) so the owner's product
    // manager can badge the items currently hidden from the public. The owner
    // still sees + edits every listing; this is display-only. No-op (all false)
    // under the default freeze policy. See ConnectOverLimitService. Mutate the
    // lean rows in place (a spread re-widens to the Document type and trips tsc).
    if (!this.overLimit || listings.length === 0) return listings;
    const suppressed = new Set(await this.overLimit.getSuppressedIds(ownerUserId, 'listing'));
    if (suppressed.size === 0) return listings;
    for (const l of listings) l.suppressed = suppressed.has(String(l._id));
    return listings;
  }

  /**
   * Per-storefront roll-up for the owner's Storefronts dashboard: products
   * (total), live (active + approved), and inquiries (leads received). One entry
   * per storefront the owner has at least one listing in.
   *
   * Strictly scoped to the caller's own listings (`ownerUserId`), so there is no
   * cross-tenant leakage: an inquiry is only counted when it sits on a listing
   * the caller owns. Two queries, never N+1:
   *   1. The owner's listings (id + storefrontId + status + moderationStatus);
   *      tally products + live per storefrontId in memory (skip null storefronts).
   *   2. The inquiries on those listing ids; map each inquiry's listingId back to
   *      its storefrontId and tally per storefront.
   */
  async storefrontStats(ownerUserId: string): Promise<StorefrontStats[]> {
    const listings = await this.listingModel
      .find({ ownerUserId: new Types.ObjectId(ownerUserId) })
      .select('_id storefrontId status moderationStatus images')
      .lean<
        Array<{
          _id: Types.ObjectId;
          storefrontId?: Types.ObjectId | null;
          status: string;
          moderationStatus: string;
          images?: string[];
        }>
      >()
      .exec();

    // storefrontId -> running tally, plus listingId -> storefrontId so the
    // inquiry pass can attribute each lead back to its shop in O(1).
    const byStorefront = new Map<string, StorefrontStats>();
    const listingToStorefront = new Map<string, string>();

    for (const listing of listings) {
      if (!listing.storefrontId) continue; // skip un-shopped (legacy) listings
      const storefrontId = String(listing.storefrontId);
      listingToStorefront.set(String(listing._id), storefrontId);

      let entry = byStorefront.get(storefrontId);
      if (!entry) {
        entry = { storefrontId, products: 0, live: 0, inquiries: 0 };
        byStorefront.set(storefrontId, entry);
      }
      entry.products += 1;
      // "Live" == buyer-visible == the SAME gate the public store grid + the web
      // console's `isLive` use: active + approved + a cover photo. A cover photo
      // is the only hard visibility requirement (a photoless card is hidden from
      // the public grid), so it is counted here too - otherwise this hub stat
      // would overcount vs the Manage page's live count.
      if (
        listing.status === 'active' &&
        listing.moderationStatus === 'approved' &&
        (listing.images?.length ?? 0) > 0
      ) {
        entry.live += 1;
      }
    }

    const listingIds = [...listingToStorefront.keys()].map((id) => new Types.ObjectId(id));
    if (listingIds.length > 0) {
      const inquiries = await this.inquiryModel
        .find({ listingId: { $in: listingIds } })
        .select('listingId')
        .lean<Array<{ listingId: Types.ObjectId }>>()
        .exec();
      for (const inquiry of inquiries) {
        const storefrontId = listingToStorefront.get(String(inquiry.listingId));
        if (!storefrontId) continue;
        const entry = byStorefront.get(storefrontId);
        if (entry) entry.inquiries += 1;
      }
    }

    return [...byStorefront.values()];
  }

  /**
   * Public listing detail: only an `active` + moderation-`approved` listing is
   * publicly visible. Anything else (draft / pending / paused / rejected) reads
   * as not-found to a non-owner.
   */
  async getPublic(id: string): Promise<
    Listing & {
      verified: boolean;
      storefront: { id: string; name: string; slug: string } | null;
      rating?: RatingAggregate;
      sellerMemberSince?: string | null;
    }
  > {
    const listing = await this.listingModel
      .findOne({ _id: id, status: 'active', moderationStatus: 'approved' })
      .lean<Listing>()
      .exec();
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    // Over-limit suppression (hide_newest): a suppressed listing reads as
    // not-found to the public, exactly like a draft/paused one. No-op under the
    // default freeze policy (empty set). The owner's own management views do not
    // call getPublic, so their suppressed items stay visible to them.
    if (this.overLimit) {
      const suppressed = await this.overLimit.getSuppressedIds(
        String(listing.ownerUserId),
        'listing',
      );
      if (suppressed.includes(String(listing._id))) {
        throw new NotFoundException('Listing not found');
      }
    }
    // Stamp the seller's verified marker (M2.3) from their Connect allowances -
    // a single owner lookup for this one listing (no N+1 concern on a detail
    // read). Same default-on entitlement source as the search/index path.
    const { verifiedBadge } = await this.allowances.getAllowances(String(listing.ownerUserId));
    // The owning shop's name + slug power the breadcrumb + "View storefront"
    // link on the detail page (null for a legacy listing with no storefront).
    const storefront = listing.storefrontId
      ? await this.storefronts.getRefById(String(listing.storefrontId))
      : null;
    // Seller rating aggregate (R2) - one lookup, attached only when rated.
    const rating = await this.reviews?.getAggregate(String(listing.ownerUserId));
    // The seller's join date for the honest "On ManekHR since ..." stat on the
    // detail page's seller card (we do NOT track years-in-business).
    const owner = await this.userModel
      ?.findById(listing.ownerUserId)
      .select('createdAt')
      .lean<{ createdAt?: Date }>()
      .exec();
    return {
      ...listing,
      // Explicitly normalize the sample-content marker on the public read: a lean
      // read of a legacy row (created before the field existed) has no isDemo, and
      // the schema default only applies on save — coerce to a hard boolean so the
      // web "Sample" badge never sees undefined. Backfill migration stamps old rows.
      isDemo: listing.isDemo === true,
      verified: verifiedBadge,
      storefront,
      ...(rating && rating.ratingCount > 0 ? { rating } : {}),
      ...(owner?.createdAt ? { sellerMemberSince: new Date(owner.createdAt).toISOString() } : {}),
    };
  }

  /**
   * A storefront's own PUBLIC products (active + approved), newest first, mapped
   * to the same `ConnectListingRef` the search/browse cards consume. All
   * listings under a storefront share its owner, so the seller's verified marker
   * is resolved once. Powers the public `/store/[slug]` page.
   */
  async listPublicByStorefront(storefrontId: string): Promise<ConnectListingRef[]> {
    const listings = await this.listingModel
      .find({
        storefrontId: new Types.ObjectId(storefrontId),
        status: 'active',
        moderationStatus: 'approved',
      })
      .sort({ createdAt: -1 })
      // DoS backstop on a public, seller-grown catalogue. Far above a real shop's
      // product count; a catalogue this large should move to keyset paging.
      .limit(LIST_HARD_CAP)
      .lean<ListingForRef[]>()
      .exec();
    if (listings.length === 0) {
      return [];
    }
    const visible = await this.dropSuppressed(listings, String(listings[0].ownerUserId));
    if (visible.length === 0) {
      return [];
    }
    const { verifiedBadge } = await this.allowances.getAllowances(String(visible[0].ownerUserId));
    // All products share one owner -> one rating lookup for the whole grid (R2).
    const rating = await this.reviews?.getAggregate(String(visible[0].ownerUserId));
    return visible.map((l) => toListingRef(l, { verified: verifiedBadge, rating }));
  }

  /**
   * All public products across the storefronts linked to a company page (the
   * company page's "Products" tab). A company page and its linked storefronts
   * share one owner, so the verified badge is resolved once from that owner.
   * No linked public shop / no products -> empty.
   */
  async listPublicByCompanyPage(companyPageId: string): Promise<ConnectListingRef[]> {
    const storefrontIds = await this.storefronts.findPublicIdsByCompanyPage(companyPageId);
    if (storefrontIds.length === 0) {
      return [];
    }
    const listings = await this.listingModel
      .find({
        storefrontId: { $in: storefrontIds },
        status: 'active',
        moderationStatus: 'approved',
      })
      .sort({ createdAt: -1 })
      // DoS backstop on a public, seller-grown catalogue (see listPublicByStorefront).
      .limit(LIST_HARD_CAP)
      .lean<ListingForRef[]>()
      .exec();
    if (listings.length === 0) {
      return [];
    }
    // A company page + its linked storefronts share one owner, so suppression is
    // resolved once for the whole grid. No-op under freeze.
    const visible = await this.dropSuppressed(listings, String(listings[0].ownerUserId));
    if (visible.length === 0) {
      return [];
    }
    const { verifiedBadge } = await this.allowances.getAllowances(String(visible[0].ownerUserId));
    // A company page + its storefronts share one owner -> one rating lookup (R2).
    const rating = await this.reviews?.getAggregate(String(visible[0].ownerUserId));
    return visible.map((l) => toListingRef(l, { verified: verifiedBadge, rating }));
  }

  /**
   * Drop the owner's over-limit-suppressed listings from a single-owner result
   * set (hide_newest policy). No-op under the default freeze policy or when the
   * over-limit service is absent (positional unit-test constructors). Keeps
   * suppression OUT of the Mongo query so the public read shape is unchanged when
   * nothing is suppressed.
   */
  private async dropSuppressed<T extends { _id: Types.ObjectId | string }>(
    listings: T[],
    ownerUserId: string,
  ): Promise<T[]> {
    if (!this.overLimit || listings.length === 0) return listings;
    const suppressed = new Set(await this.overLimit.getSuppressedIds(ownerUserId, 'listing'));
    if (suppressed.size === 0) return listings;
    return listings.filter((l) => !suppressed.has(String(l._id)));
  }

  /**
   * Validate + stamp a listing's product video(s) for persistence. Mirrors the
   * feed video path (feed.service): every clip `url` AND its optional `posterUrl`
   * must be a file THIS user uploaded (shared media-ownership guard), then each
   * clip's `durationSec` is set from the SERVER-parsed duration on the owned
   * upload record - never a client claim. Empty input -> empty result (clears the
   * video on an explicit `videos: []` patch).
   *
   * `grandfatheredVideos` (update path) exempts a clip already on the listing
   * from the ownership-RECORD check (its url/posterUrl were accepted before this
   * edit); format/host checks still apply to every url.
   */
  private async buildOwnedVideos(
    videos: Array<{ url: string; posterUrl?: string }> | undefined,
    ownerUserId: string,
    grandfatheredVideos?: Array<{ url: string; posterUrl?: string }>,
  ): Promise<Array<{ url: string; posterUrl?: string; durationSec?: number }>> {
    if (!videos || videos.length === 0) return [];
    // Flatten clip url + poster url for the batched ownership check (the guard
    // skips empty/undefined slots, so a posterless clip is fine).
    const grandfatheredUrls = (grandfatheredVideos ?? []).flatMap((v) => [v.url, v.posterUrl]);
    const submittedUrls = videos.flatMap((v) => [v.url, v.posterUrl]);
    await this.media.assertOwnedMedia(submittedUrls, ownerUserId, { grandfatheredUrls });
    return Promise.all(
      videos.map(async (v) => {
        const durationSec = await this.media.getServerVideoDurationByUrl(v.url, ownerUserId);
        return {
          url: v.url,
          ...(v.posterUrl ? { posterUrl: v.posterUrl } : {}),
          ...(durationSec != null ? { durationSec } : {}),
        };
      }),
    );
  }

  /** Load a listing and assert the caller owns it; 404 otherwise (no existence leak). */
  private async loadOwned(id: string, ownerUserId: string): Promise<ListingDocument> {
    const listing = await this.listingModel.findById(id);
    if (!listing || String(listing.ownerUserId) !== ownerUserId) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }
}
