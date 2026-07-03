import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { ConnectProfile } from '../profile/schemas/connect-profile.schema';
import { User } from '../../users/schemas/user.schema';
import { Listing, type ListingDocument } from '../marketplace/schemas/listing.schema';
import { Post } from '../feed/schemas/post.schema';
import { Job } from '../jobs/schemas/job.schema';
import { Storefront } from '../entities/schemas/storefront.schema';
import { CompanyPage } from '../entities/schemas/company-page.schema';
import { ConnectProfileService, type ConnectPersonRef } from '../profile/connect-profile.service';
import { MeiliClient } from './meili.client';
import { SearchCacheService } from './search-cache.service';
import { SearchBlockFilterService } from './search-block-filter.service';
import { romanizedIndexField } from './transliteration';
import {
  CONNECT_LISTINGS_INDEX,
  CONNECT_PEOPLE_INDEX,
  CONNECT_POSTS_INDEX,
  CONNECT_JOBS_INDEX,
  CONNECT_STOREFRONTS_INDEX,
  CONNECT_PAGES_INDEX,
  CONNECT_SEARCH_INDEXES,
} from './search-index.registry';
import { ErpLinkService } from '../profile/erp-link.service';
import {
  type PeopleSearchFilters,
  hasPeopleFilters,
  normalizeSkillsForIndex,
  deriveExperienceYears,
  buildPeopleMeiliFilter,
  buildPeopleMongoConditions,
} from './people-search.helpers';
import {
  type ConnectListingDocument,
  type ConnectListingRef,
  type ListingSearchFilters,
  type ListingOwnerSignals,
  buildListingDocument,
  buildListingMeiliFilter,
  buildListingMongoConditions,
  buildListingSort,
  normalizeListingSort,
  applyVerifiedRefFilter,
  applyVerifiedFirstOrder,
  hasListingFilters,
  toListingRef,
} from './listing-search.helpers';
import {
  type ConnectPostRef,
  type PostSearchFilters,
  buildPostDocument,
  buildPostMeiliFilter,
  buildPostMongoConditions,
  hasPostFilters,
  toPostRef,
} from './post-search.helpers';
import { ConnectAllowanceService } from '../monetization/connect-allowance.service';
import { ConnectOverLimitService } from '../over-limit/connect-over-limit.service';
import type { ConnectProfileChangedEvent } from '../profile/events/connect-profile.events';
import { CONNECT_PROFILE_CHANGED } from '../profile/events/connect-profile.events';
import type { ConnectListingChangedEvent } from '../marketplace/events/connect-listing.events';
import { CONNECT_LISTING_CHANGED } from '../marketplace/events/connect-listing.events';
import type { ConnectPostChangedEvent } from '../feed/events/connect-post.events';
import { CONNECT_POST_CHANGED } from '../feed/events/connect-post.events';
import type { ConnectJobChangedEvent } from '../jobs/events/connect-job.events';
import { CONNECT_JOB_CHANGED } from '../jobs/events/connect-job.events';
import {
  type ConnectJobRef,
  type JobSearchFilters,
  buildJobDocument,
  buildJobMeiliFilter,
  buildJobMongoConditions,
  hasJobFilters,
  toJobRef,
} from './job-search.helpers';
import {
  type ConnectStorefrontRef,
  type ConnectStorefrontDocument,
  type StorefrontSearchFilters,
  buildStorefrontDocument,
  buildStorefrontMeiliFilter,
  buildStorefrontMongoConditions,
  hasStorefrontFilters,
  toStorefrontRef,
} from './storefront-search.helpers';
import {
  type ConnectPageRef,
  type ConnectPageDocument,
  type PageSearchFilters,
  buildPageDocument,
  buildPageMeiliFilter,
  buildPageMongoConditions,
  hasPageFilters,
  toPageRef,
} from './page-search.helpers';
import type { ConnectStorefrontChangedEvent } from '../entities/events/connect-storefront.events';
import { CONNECT_STOREFRONT_CHANGED } from '../entities/events/connect-storefront.events';
import type { ConnectCompanyPageChangedEvent } from '../entities/events/connect-company-page.events';
import { CONNECT_COMPANY_PAGE_CHANGED } from '../entities/events/connect-company-page.events';

/**
 * The Meilisearch index holding searchable people documents. One document per
 * public `ConnectProfile`, keyed by `id` = the `User` id. The uid + its index
 * settings now live in the shared `search-index.registry`; re-exported here so
 * existing importers keep their path.
 */
export { CONNECT_PEOPLE_INDEX };

/** Maximum people results a single search returns — both backends honour it. */
const SEARCH_RESULT_CAP = 25;

/** Maximum listing results per marketplace search; both backends honour it. */
const LISTINGS_SEARCH_RESULT_CAP = 25;

/** Maximum post results per search; both backends honour it. */
const POSTS_SEARCH_RESULT_CAP = 25;

/** Maximum job results per search; both backends honour it. */
const JOBS_SEARCH_RESULT_CAP = 25;

/** Maximum storefront results per search; both backends honour it. */
const STOREFRONTS_SEARCH_RESULT_CAP = 25;

/** Maximum company-page results per search; both backends honour it. */
const PAGES_SEARCH_RESULT_CAP = 25;

/**
 * A render-ready feed-post search row: the slim post card plus the hydrated
 * author identity (the one canonical people-card shape). Consumed by the
 * federated posts arm + the web Posts tab.
 */
export interface ConnectPostResult extends ConnectPostRef {
  author: ConnectPersonRef | null;
}

/**
 * Upper bound on rows pulled per collection in the Mongo fallback before the
 * merge + cap. Generous enough that the regex match is not silently truncated
 * for any realistic query, bounded enough to keep the scan cheap.
 */
const FALLBACK_SCAN_CAP = 100;

/** Bounds a bulk reindex page so first-provisioning never loads the world. */
const REINDEX_PAGE_SIZE = 500;

/**
 * One person document as stored in the Meilisearch `connect_people` index.
 * A `type` (not an `interface`) so it satisfies `MeiliDocument`
 * (`Record<string, unknown>`) — TS gives object-literal types an implicit
 * index signature, interfaces it does not.
 */
type ConnectPeopleDocument = {
  /** Index primary key, the `User` id. */
  id: string;
  /** Display name (canonical on `User`). */
  name: string;
  /** Connect headline one-liner (`''` when unset; Meili needs a value). */
  headline: string;
  /** Embroidery skill tags, lowercased for consistent search + facet filtering. */
  skills: string[];
  /** Home district / textile hub, lowercased; a filterable facet. */
  district: string;
  /** "Open to work" toggle; a filterable facet for candidate search. */
  openToWork: boolean;
  /** "Open to hiring" toggle; a filterable facet. */
  openToHiring: boolean;
  /** Service titles the member offers (from profile.services). Lowest-rank searchable
   *  field powering "Find a Service" free-text recall. */
  services: string[];
  /** "Providing services" toggle (= profile.openTo.customOrders); a filterable facet
   *  for the "Find a Service" provider filter. */
  providingServices: boolean;
  /** 1 when ERP-linked at index time else 0. Numeric so it drives the erpLinked:desc boost. */
  erpLinked: number;
  /** Whole years of trade experience; sortable and a ranking tie-break. */
  experienceYears: number;
  /** SRCH-I18N-1: Latin romanization of any Gujarati-script name/headline/skill/
   *  service tokens, so a Latin query finds a Gujarati-script profile. Lowest-rank
   *  searchable; `''` when all-Latin. Not displayed. */
  romanized: string;
  /**
   * Demo Content scope: 0 for a real member, 1 for a seeded sample one (read from
   * the member's `User.isDemo`). Numeric so the `demoRank:asc` ranking rule sinks
   * demo below an otherwise-equal real tie. Same flag that drives the web
   * "Sample" badge + the demo-rank.ts down-rank — one source of truth.
   */
  demoRank: number;
};

/** The `ConnectProfile` slice read when indexing one person. */
type ProfileForIndex = {
  headline?: string;
  skills?: string[];
  visibility?: string;
  district?: string;
  openTo?: { work?: boolean; hiring?: boolean; customOrders?: boolean };
  experience?: Array<{ from?: Date | null; to?: Date | null }>;
  /** Offered services; only the title is indexed (note is not searchable). */
  services?: Array<{ title?: string; note?: string }>;
};

/**
 * `SearchService` — Connect people search (Phase 2, Wave 4 — B5).
 *
 * Backs `GET /connect/search`. Two interchangeable backends:
 *
 *  - **Meilisearch** (when {@link MeiliClient.enabled}) — typo-tolerant
 *    full-text search over the `connect_people` index. Preferred: it ranks
 *    name + headline + skills together and tolerates misspellings.
 *  - **Mongo-regex fallback** (when Meili is not configured / unreachable) —
 *    a case-insensitive regex over public `ConnectProfile.headline` /
 *    `.skills` plus `User.name`, merged and de-duplicated. Zero-config: the
 *    endpoint works on a bare local stack with no Meilisearch.
 *
 * The index is kept warm by an event hook: `ConnectProfileService` emits
 * {@link CONNECT_PROFILE_CHANGED} on every profile create / update, and
 * {@link handleProfileChanged} re-indexes that one person. All search reads
 * resolve to the viewer-facing `{ userId, name, avatar, headline }` shape via
 * `ConnectProfileService.getPeopleByIds` — the single hydration path, so a
 * people card renders identically wherever it appears.
 */
@Injectable()
export class SearchService {
  private readonly tracer = trace.getTracer('connect.search');

  constructor(
    @InjectModel(ConnectProfile.name)
    private readonly profileModel: Model<ConnectProfile>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    @InjectModel(Listing.name)
    private readonly listingModel: Model<ListingDocument>,
    @InjectModel(Post.name)
    private readonly postModel: Model<Post>,
    @InjectModel(Job.name)
    private readonly jobModel: Model<Job>,
    private readonly connectProfileService: ConnectProfileService,
    private readonly meili: MeiliClient,
    private readonly erpLink: ErpLinkService,
    private readonly allowances: ConnectAllowanceService,
    /**
     * Over-limit suppression (grandfathering) — post-filters suppressed listings
     * out of search + browse results (hide_newest policy). @Optional + LAST so
     * positional unit-test constructors keep working; a no-op under freeze.
     */
    @Optional() private readonly overLimit?: ConnectOverLimitService,
    /**
     * Short-TTL Redis prefix cache fronting the Meilisearch engine round-trip
     * (SRCH-PERF-1). @Optional + LAST so positional unit-test constructors keep
     * working; absent => search queries Meili directly. It caches ONLY the
     * engine output (hit ids + facet counts), NEVER the post-hydration result,
     * so the live author-active gate (`inactiveOwnerIds`) and the per-viewer
     * block filter still run on every request — a cache hit cannot leak a
     * banned author's or a blocked author's content.
     */
    @Optional() private readonly searchCache?: SearchCacheService,
    /**
     * SRCH-VERT-1 — the storefront + company-page models, registered read-only in
     * this module's DI scope (the entities module owns the canonical CRUD). Used
     * to index + hydrate the two new verticals. @Optional + LAST so positional
     * unit-test constructors (which build SearchService with the first 9 args)
     * keep working; production DI always supplies them, so the index / search
     * methods that need them assert their presence.
     */
    @Optional()
    @InjectModel(Storefront.name)
    private readonly storefrontModel?: Model<Storefront>,
    @Optional()
    @InjectModel(CompanyPage.name)
    private readonly companyPageModel?: Model<CompanyPage>,
    /**
     * CN-SRCH-7 (feed harden Bucket 9): the viewer-contextual block gate, so the
     * marketplace bare-landing browse (browseRecentListings) drops a blocked
     * seller's listings — every OTHER read applies it, this direct path did not.
     * @Optional + LAST so positional unit-test constructors keep working; when
     * absent (a viewer-less call or a test) the block filter is simply skipped.
     * Already provided by ConnectSearchModule.
     */
    @Optional()
    private readonly blockFilter?: SearchBlockFilterService,
  ) {}

  /**
   * Wrap a Meilisearch id-lookup in the short-TTL prefix cache (SRCH-PERF-1).
   * `keyParts` must capture everything that changes the engine result (query +
   * filters [+ page]) but NEVER the viewer — the cached value is hydrated +
   * gated per-request downstream. Degrades to a direct `compute()` when the
   * cache is absent (unit tests / no-Redis) or unhealthy.
   */
  private withMeiliCache<T>(
    namespace: string,
    keyParts: unknown,
    compute: () => Promise<T>,
  ): Promise<T> {
    return this.searchCache ? this.searchCache.wrap(namespace, keyParts, compute) : compute();
  }

  /**
   * SECURITY (SRCH-LEAK-1 / SRCH-LEAK-4): author-active gate.
   *
   * Resolve, from a set of owning-user ids, the subset whose `User` account is
   * erased / banned / deactivated — i.e. `isActive === false` (the exact flag
   * `AccountErasureService` flips on erasure, alongside `deletedAt`). One
   * batched indexed `$in` lookup over the distinct owners on the page (never
   * per-row), mirroring how people hydration (`getPeopleByIds`) already re-reads
   * live `User` state.
   *
   * Why this exists: `removeFromConnectForErasure` only de-indexes the *person*
   * card (it flips `ConnectProfile.visibility`), but a banned user's listings /
   * posts / jobs keep their own `active`/`approved`/`public`/`open` state, and
   * the entity hydration re-pins on the ENTITY state — never the author's
   * account state. So before this gate, a banned seller's shop / posts / job ads
   * stayed fully findable (SRCH-LEAK-1). Re-reading live `isActive` at hydration
   * also closes the cross-vertical staleness window between a ban and the next
   * reindex (SRCH-LEAK-4) — the gate is computed from the live `User` row, not a
   * possibly-stale index document.
   *
   * Returns a string `Set` so callers can match on `String(ownerId)` regardless
   * of the id's runtime type. A user row that is missing entirely is treated as
   * inactive (fail-closed): an owner whose account no longer exists must not keep
   * surfacing content.
   */
  private async inactiveOwnerIds(ownerUserIds: string[]): Promise<Set<string>> {
    const distinct = [...new Set(ownerUserIds)].filter((id) => Types.ObjectId.isValid(id));
    if (distinct.length === 0) return new Set<string>();
    const objectIds = distinct.map((id) => new Types.ObjectId(id));
    // Read only the ACTIVE owners back; anything not returned (inactive OR a
    // deleted/missing row) is treated as inactive below — fail-closed.
    const activeOwners = await this.userModel
      .find({ _id: { $in: objectIds }, isActive: true })
      .select('_id')
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    const activeSet = new Set(activeOwners.map((u) => String(u._id)));
    const inactive = new Set<string>();
    for (const id of distinct) {
      if (!activeSet.has(id)) inactive.add(id);
    }
    return inactive;
  }

  /**
   * Resolve a seller's denormalized listing signals (M2.3) from their Connect
   * allowances: the `verifiedBadge` entitlement -> the `verified` marker, and
   * the `searchPriority` number -> the paid ranking boost.
   */
  private async ownerSignals(ownerUserId: string): Promise<ListingOwnerSignals> {
    const { verifiedBadge, searchPriority } = await this.allowances.getAllowances(ownerUserId);
    return { verified: verifiedBadge, searchPriority };
  }

  /**
   * Batch {@link ownerSignals} over a set of listings' owners, de-duplicating so
   * a page of one seller's listings costs a single allowance read.
   */
  private async ownerSignalsBatch(
    ownerUserIds: string[],
  ): Promise<Map<string, ListingOwnerSignals>> {
    const distinct = [...new Set(ownerUserIds)];
    const entries = await Promise.all(
      distinct.map(async (id) => [id, await this.ownerSignals(id)] as const),
    );
    return new Map(entries);
  }

  /**
   * Search public people by free-text `query` — matched against name,
   * headline, and skills. Returns a PAGE of viewer-facing people refs plus the
   * full match `total` (the count-leak-free source for the web people-tab
   * infinite-scroll `hasMore`), symmetric to {@link searchListings}. A blank /
   * whitespace-only query with no facet resolves to an empty page without
   * touching either backend.
   *
   * `page` (limit/offset) is the ACTIVE-vertical page the federated layer threads
   * through for the focused people tab (Phase 2, progressive loading); the
   * typeahead / `type=all` preview callers omit it and get the default first
   * batch. The page is part of the Meili cache key (`p: page`) so each page
   * caches separately; the cached value is engine ids + total only (never the
   * hydrated cards), so the per-viewer block filter still runs per request.
   */
  async searchPeople(
    query: string,
    filters: PeopleSearchFilters = {},
    page: { limit: number; offset: number } = { limit: SEARCH_RESULT_CAP, offset: 0 },
  ): Promise<{ people: ConnectPersonRef[]; total: number }> {
    return this.withSpan('connect.search.searchPeople', async (span) => {
      const trimmed = query.trim();
      // A request needs either a text term or at least one facet. A bare blank
      // query (the search box before the user types) resolves to an empty page.
      if (!trimmed && !hasPeopleFilters(filters)) {
        span.setAttribute('result', 'blank-query');
        return { people: [], total: 0 };
      }

      let userIds: string[];
      let total: number;
      if (this.meili.enabled) {
        const result = await this.withMeiliCache(
          'people',
          { q: trimmed, f: filters, p: page },
          () => this.searchViaMeili(trimmed, filters, page),
        );
        userIds = result.ids;
        total = result.total;
      } else {
        // Mongo fallback: it returns the capped match set; page it in memory and
        // report that set's size as the total (degraded-mode best effort, exactly
        // as searchListings' Mongo fallback does).
        const allIds = await this.searchViaMongo(trimmed, filters);
        total = allIds.length;
        userIds = allIds.slice(page.offset, page.offset + page.limit);
      }

      span.setAttributes({
        backend: this.meili.enabled ? 'meili' : 'mongo',
        matchCount: userIds.length,
      });
      if (userIds.length === 0) return { people: [], total };

      // CN-SRCH-2 (feed harden Bucket 5): people search was the only vertical
      // that ran NEITHER the shared author-active gate NOR a live-visibility
      // re-check, so a suspended user (isActive:false) or a since-hidden profile
      // whose Meili doc had not yet been reindexed could still surface. Apply
      // BOTH query-time gates (the actual security backstop) before hydration,
      // mirroring searchListings' inactiveOwnerIds pattern:
      //   1. drop owners who are no longer active accounts;
      //   2. drop anyone whose LIVE ConnectProfile.visibility !== 'public'
      //      (the "stale index row after public->hidden/connections" half).
      const [inactive, publicIds] = await Promise.all([
        this.inactiveOwnerIds(userIds),
        this.publicProfileUserIds(userIds),
      ]);
      const gatedIds = userIds.filter((id) => !inactive.has(id) && publicIds.has(id));
      span.setAttribute('gatedCount', gatedIds.length);
      if (gatedIds.length === 0) return { people: [], total };

      // Hydrate through the one canonical people-card path. `getPeopleByIds`
      // returns name+avatar from `User` and headline from `ConnectProfile` in the
      // caller-supplied (Meili relevance) order (CN-SRCH-1); a `User` deleted
      // since indexing simply drops out.
      const people = await this.connectProfileService.getPeopleByIds(gatedIds);
      span.setAttribute('resultCount', people.length);
      return { people, total };
    });
  }

  /**
   * The subset of `userIds` whose LIVE `ConnectProfile.visibility === 'public'`.
   * CN-SRCH-2 query-time backstop: an index row can be stale after a
   * public->hidden/connections flip, so people search re-checks the live profile
   * before surfacing anyone. A missing profile is treated as non-public
   * (fail-closed). One indexed read; returns a string Set for `String(id)` match.
   */
  private async publicProfileUserIds(userIds: string[]): Promise<Set<string>> {
    const distinct = [...new Set(userIds)].filter((id) => Types.ObjectId.isValid(id));
    if (distinct.length === 0) return new Set<string>();
    const objectIds = distinct.map((id) => new Types.ObjectId(id));
    const rows = await this.profileModel
      .find({ userId: { $in: objectIds }, visibility: 'public' })
      .select('userId')
      .lean<Array<{ userId: Types.ObjectId }>>()
      .exec();
    return new Set(rows.map((r) => String(r.userId)));
  }

  /**
   * Index (upsert) one person into the `connect_people` index. Called by the
   * profile-changed hook and by {@link reindexAllPeople}. A no-op when Meili
   * is disabled. A non-public / hidden profile is *removed* from the index so
   * search never surfaces it; an absent profile is likewise removed.
   */
  async indexPerson(userId: string | Types.ObjectId): Promise<void> {
    if (!this.meili.enabled) return;
    if (!Types.ObjectId.isValid(userId)) return;
    const id = new Types.ObjectId(userId);

    return this.withSpan('connect.search.indexPerson', async (span) => {
      const [user, profile] = await Promise.all([
        this.userModel
          .findById(id)
          .select('name isDemo')
          .lean<{ name?: string; isDemo?: boolean } | null>()
          .exec(),
        this.profileModel
          .findOne({ userId: id })
          .select('headline skills visibility district openTo experience services')
          .lean<ProfileForIndex | null>()
          .exec(),
      ]);

      // Only `public` profiles are searchable. A missing user, missing
      // profile, or a profile dialled to `connections` / `hidden` is purged
      // from the index, keeping search and visibility consistent.
      if (!user || !profile || profile.visibility !== 'public') {
        span.setAttribute('action', 'delete');
        await this.meili.deleteDocument(CONNECT_PEOPLE_INDEX, String(id));
        return;
      }

      // ERP-linked is derived live (never stored) and snapshotted at index
      // time; it self-heals on the next profile write or reindex. Computed only
      // for public profiles (the non-public branch already returned).
      const erp = await this.erpLink.getUserStatus(id);

      span.setAttribute('action', 'upsert');
      const doc: ConnectPeopleDocument = {
        id: String(id),
        name: user.name ?? '',
        headline: profile.headline?.trim() ?? '',
        skills: normalizeSkillsForIndex(profile.skills ?? []),
        district: (profile.district ?? '').trim().toLowerCase(),
        openToWork: profile.openTo?.work ?? false,
        openToHiring: profile.openTo?.hiring ?? false,
        // Service titles -> searchable; "providing services" -> filterable facet.
        services: (profile.services ?? []).map((s) => s.title ?? '').filter(Boolean),
        providingServices: profile.openTo?.customOrders ?? false,
        erpLinked: erp.linked ? 1 : 0,
        experienceYears: deriveExperienceYears(profile.experience ?? []),
        romanized: romanizedIndexField(
          user.name,
          profile.headline,
          profile.skills,
          (profile.services ?? []).map((s) => s.title ?? ''),
        ),
        // 0 real / 1 demo (from User.isDemo) so `demoRank:asc` sinks sample people.
        demoRank: user.isDemo ? 1 : 0,
      };
      await this.meili.upsertDocuments(CONNECT_PEOPLE_INDEX, [doc]);
    });
  }

  /**
   * Bulk-index every public profile — for first provisioning of the
   * `connect_people` index (or a rebuild after a settings change). Ensures the
   * index + its searchable attributes exist, then pages through public
   * profiles upserting them. A no-op when Meili is disabled. Returns the count
   * of indexed people.
   */
  async reindexAllPeople(): Promise<number> {
    if (!this.meili.enabled) return 0;

    return this.withSpan('connect.search.reindexAllPeople', async (span) => {
      await this.meili.ensureIndex(
        CONNECT_SEARCH_INDEXES.people.uid,
        CONNECT_SEARCH_INDEXES.people.settings,
      );

      let indexed = 0;
      for (let skip = 0; ; skip += REINDEX_PAGE_SIZE) {
        const page = await this.profileModel
          .find({ visibility: 'public' })
          .select('userId headline skills district openTo experience services')
          .sort({ _id: 1 })
          .skip(skip)
          .limit(REINDEX_PAGE_SIZE)
          .lean<Array<{ userId: Types.ObjectId } & ProfileForIndex>>()
          .exec();
        if (page.length === 0) break;

        const userIds = page.map((p) => String(p.userId));
        const users = await this.userModel
          .find({ _id: { $in: page.map((p) => p.userId) } })
          .select('name isDemo')
          .lean<Array<{ _id: Types.ObjectId; name?: string; isDemo?: boolean }>>()
          .exec();
        const nameByUser = new Map(users.map((u) => [String(u._id), u.name ?? '']));
        // Demo Content scope: per-user seeded-sample marker for the demoRank field.
        const demoByUser = new Map(users.map((u) => [String(u._id), Boolean(u.isDemo)]));

        // ERP-linked status per person (derived, snapshotted at index time).
        const erpLinkedByUser = new Map<string, number>();
        await Promise.all(
          page.map(async (p) => {
            const erp = await this.erpLink.getUserStatus(p.userId);
            erpLinkedByUser.set(String(p.userId), erp.linked ? 1 : 0);
          }),
        );

        const docs = page.map<ConnectPeopleDocument>((p) => ({
          id: String(p.userId),
          name: nameByUser.get(String(p.userId)) ?? '',
          headline: p.headline?.trim() ?? '',
          skills: normalizeSkillsForIndex(p.skills ?? []),
          district: (p.district ?? '').trim().toLowerCase(),
          openToWork: p.openTo?.work ?? false,
          openToHiring: p.openTo?.hiring ?? false,
          // Same service-title + providing-services mapping as indexPerson.
          services: (p.services ?? []).map((s) => s.title ?? '').filter(Boolean),
          providingServices: p.openTo?.customOrders ?? false,
          erpLinked: erpLinkedByUser.get(String(p.userId)) ?? 0,
          experienceYears: deriveExperienceYears(p.experience ?? []),
          romanized: romanizedIndexField(
            nameByUser.get(String(p.userId)),
            p.headline,
            p.skills,
            (p.services ?? []).map((s) => s.title ?? ''),
          ),
          // 0 real / 1 demo (from User.isDemo) so `demoRank:asc` sinks sample people.
          demoRank: demoByUser.get(String(p.userId)) ? 1 : 0,
        }));
        await this.meili.upsertDocuments(CONNECT_PEOPLE_INDEX, docs);
        indexed += userIds.length;

        if (page.length < REINDEX_PAGE_SIZE) break;
      }

      span.setAttribute('indexedCount', indexed);
      return indexed;
    });
  }

  /**
   * Event hook — keeps the `connect_people` index warm. `ConnectProfileService`
   * emits {@link CONNECT_PROFILE_CHANGED} on every profile create / update;
   * this re-indexes that one person. `async: true` so a slow Meili write never
   * blocks the profile-write request thread; `indexPerson` itself swallows all
   * faults (via `MeiliClient`), so this listener cannot throw.
   */
  @OnEvent(CONNECT_PROFILE_CHANGED, { async: true })
  async handleProfileChanged(payload: ConnectProfileChangedEvent): Promise<void> {
    await this.indexPerson(payload.userId);
  }

  // ── Marketplace listings (M1.4) ──────────────────────────────────────────

  /**
   * Public marketplace listing search. Returns at most
   * {@link LISTINGS_SEARCH_RESULT_CAP} lean `Listing` rows that are
   * `active` + `approved`, honouring the optional facets
   * (category / district / price floor range / ownerUserId for the my-
   * listings reuse). A blank query with no facet short-circuits to `[]` --
   * the buyer landing on the marketplace before they have typed.
   *
   * Symmetric to {@link searchPeople}: Meili-first when configured, with a
   * case-insensitive Mongo-regex fallback so the endpoint works on a bare
   * local stack with no Meilisearch.
   *
   * The returned `tagCounts` map (populated only on the Meili path) carries
   * the facet distribution for the `tags` attribute -- each tag slug mapped
   * to the number of matching listings that carry it. The web uses this to
   * rank tag-filter chips by popularity. An empty map is returned on the
   * Mongo fallback or when Meili returns no distribution data.
   *
   * The returned `categoryCounts` map mirrors `tagCounts` for the `category`
   * attribute -- each category slug mapped to the number of matching listings
   * in that category. Populated from the Meili facet distribution; empty on
   * the Mongo fallback path.
   */
  async searchListings(
    query: string,
    filters: ListingSearchFilters = {},
    page: { limit: number; offset: number } = { limit: LISTINGS_SEARCH_RESULT_CAP, offset: 0 },
  ): Promise<{
    listings: ConnectListingRef[];
    /** Full match count (all pages) - the web infinite-scroll hasMore. */
    total: number;
    tagCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
    // districtCounts mirrors categoryCounts for the `district` attribute (Meili
    // facet distribution); drives the marketplace Location filter chips on the
    // web (ListingFacetPanel). Empty on the Mongo fallback. Keep in sync with
    // searchListingsViaMeili + federated-search.service response threading.
    districtCounts: Record<string, number>;
  }> {
    return this.withSpan('connect.search.searchListings', async (span) => {
      const trimmed = query.trim();
      if (!trimmed && !hasListingFilters(filters)) {
        span.setAttribute('result', 'blank-query');
        return { listings: [], total: 0, tagCounts: {}, categoryCounts: {}, districtCounts: {} };
      }

      let ids: string[];
      let total: number;
      let tagCounts: Record<string, number>;
      let categoryCounts: Record<string, number>;
      let districtCounts: Record<string, number>;

      if (this.meili.enabled) {
        const result = await this.withMeiliCache(
          'listings',
          { q: trimmed, f: filters, p: page },
          () => this.searchListingsViaMeili(trimmed, filters, page),
        );
        ids = result.ids;
        total = result.total;
        tagCounts = result.tagCounts;
        categoryCounts = result.categoryCounts;
        districtCounts = result.districtCounts;
      } else {
        // Mongo fallback: it returns the capped match set; page it in memory and
        // report that set's size as the total (degraded-mode best effort).
        const allIds = await this.searchListingsViaMongo(trimmed, filters);
        total = allIds.length;
        ids = allIds.slice(page.offset, page.offset + page.limit);
        tagCounts = {};
        categoryCounts = {};
        districtCounts = {};
      }

      span.setAttributes({
        backend: this.meili.enabled ? 'meili' : 'mongo',
        matchCount: ids.length,
      });
      if (ids.length === 0)
        return { listings: [], total, tagCounts, categoryCounts, districtCounts };

      // Hydrate from Mongo, preserving the search-ranking order. Re-pin the
      // public gate during hydration so a stale doc in the index (between an
      // admin reject and the next reindex) cannot leak through. Map through
      // `toListingRef` so the federation hands web a slim, render-ready card
      // shape (symmetric to ConnectPersonRef on the people vertical).
      const docs = await this.listingModel
        .find({
          _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
          status: 'active',
          moderationStatus: 'approved',
        })
        .lean<Array<Listing & { _id: Types.ObjectId }>>()
        .exec();
      const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
      const orderedDocsAll = ids
        .map((id) => byId.get(id))
        .filter((doc): doc is Listing & { _id: Types.ObjectId } => Boolean(doc));
      // SECURITY (SRCH-LEAK-1 / SRCH-LEAK-4): author-active gate. Drop any listing
      // whose owning account is erased / banned / deactivated (`isActive=false`),
      // re-read LIVE from `User` in one batched `$in`. Closes the ban-discoverability
      // gap (a banned seller's de-indexed person card hid them, but their listings
      // re-pinned on the listing's own active+approved state and stayed findable)
      // and the cross-vertical staleness window before the next reindex.
      const inactiveOwners = await this.inactiveOwnerIds(
        orderedDocsAll.map((doc) => String(doc.ownerUserId)),
      );
      const orderedDocsRaw =
        inactiveOwners.size === 0
          ? orderedDocsAll
          : orderedDocsAll.filter((doc) => !inactiveOwners.has(String(doc.ownerUserId)));
      // Over-limit suppression: drop the owner's suppressed (newest-beyond-limit)
      // listings from public search under the hide_newest policy. Post-filter (not
      // an index attribute) so the index stays drift-free re: suppression; a no-op
      // under the default freeze policy. See the over-limit policy doc.
      const orderedDocs = this.overLimit
        ? await this.overLimit.filterSuppressed(
            orderedDocsRaw,
            'listing',
            (doc) => String(doc.ownerUserId),
            (doc) => String(doc._id),
          )
        : orderedDocsRaw;
      // Resolve each owner's verified marker (M2.3), batched by distinct owner.
      const signals = await this.ownerSignalsBatch(
        orderedDocs.map((doc) => String(doc.ownerUserId)),
      );
      const hydrated = orderedDocs.map((doc) =>
        toListingRef(doc, { verified: signals.get(String(doc.ownerUserId))?.verified }),
      );

      // Apply the verified facet + verified-first ordering on the hydrated cards.
      // This is the single correctness point for `verified` across BOTH backends:
      // the Mongo fallback has no `verified` column so it filters/sorts here; the
      // Meili path already filtered + ordered (and capped) at query time, so this
      // is a harmless no-op refinement there. Re-cap after the filter so the page
      // never exceeds the result cap (and the Mongo over-fetch is bounded back).
      const sortKey = normalizeListingSort(filters.sort);
      const listings = applyVerifiedFirstOrder(
        applyVerifiedRefFilter(hydrated, filters.verified),
        sortKey,
      ).slice(0, page.limit);

      span.setAttribute('resultCount', listings.length);
      return { listings, total, tagCounts, categoryCounts, districtCounts };
    });
  }

  /**
   * Recent public listings for the marketplace LANDING (the bare browse before
   * any query / facet). The federated search returns empty for a blank query by
   * design, so the marketplace showed nothing until you filtered; this gives the
   * landing real products. Mongo-backed, newest first, with the SAME public gate
   * (`status: 'active'` + `moderationStatus: 'approved'`), `toListingRef` card
   * shape, and verified-owner signals as `searchListings`.
   */
  async browseRecentListings(
    opts: { limit?: number; offset?: number; viewerUserId?: string } = {},
  ): Promise<{
    listings: ReturnType<typeof toListingRef>[];
    /** Full public-corpus count - the web infinite-scroll hasMore on the landing. */
    total: number;
    // Corpus-wide facet counts (NOT capped by `limit`) so the marketplace bare
    // landing can render counted Category pills + Location chips before any
    // search runs (the federated search path gets its counts from Meili facet
    // distribution instead). Keys are lowercased to match the Meili `district`
    // facet keys; the web title-cases for display. Drives CategoryStrip +
    // ListingFacetPanel (web).
    categoryCounts: Record<string, number>;
    districtCounts: Record<string, number>;
  }> {
    return this.withSpan('connect.search.browseRecentListings', async (span) => {
      const capped = Math.min(60, Math.max(1, Math.floor(opts.limit ?? 30)));
      const offset = Math.max(0, Math.floor(opts.offset ?? 0));
      const PUBLIC = { status: 'active', moderationStatus: 'approved' } as const;
      // Recent cards (paginated via skip/limit) + corpus facet counts + the total
      // public count, in parallel. The $facet aggregation + count group the whole
      // public corpus (independent of the page); district is lowercased to match
      // the Meili-faceted keys, empties excluded.
      const [docs, facetRows, total] = await Promise.all([
        this.listingModel
          .find(PUBLIC)
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(capped)
          .lean<Array<Listing & { _id: Types.ObjectId }>>()
          .exec(),
        this.listingModel
          .aggregate<{
            category: Array<{ _id: string; n: number }>;
            district: Array<{ _id: string; n: number }>;
          }>([
            { $match: PUBLIC },
            {
              $facet: {
                category: [
                  { $match: { category: { $type: 'string', $ne: '' } } },
                  { $group: { _id: '$category', n: { $sum: 1 } } },
                ],
                district: [
                  { $match: { 'location.district': { $type: 'string', $ne: '' } } },
                  { $group: { _id: { $toLower: '$location.district' }, n: { $sum: 1 } } },
                ],
              },
            },
          ])
          .exec(),
        this.listingModel.countDocuments(PUBLIC).exec(),
      ]);
      const facet = facetRows[0];
      const categoryCounts = Object.fromEntries(
        (facet?.category ?? []).map((row) => [row._id, row.n]),
      );
      const districtCounts = Object.fromEntries(
        (facet?.district ?? []).map((row) => [row._id, row.n]),
      );
      span.setAttribute('resultCount', docs.length);
      if (docs.length === 0) return { listings: [], total, categoryCounts, districtCounts };
      // Over-limit suppression on the bare landing (hide_newest); no-op under
      // freeze. Corpus `total` + facet counts stay approximate (a handful of
      // hidden items are not subtracted) — acceptable for a landing browse.
      const visibleDocs = this.overLimit
        ? await this.overLimit.filterSuppressed(
            docs,
            'listing',
            (doc) => String(doc.ownerUserId),
            (doc) => String(doc._id),
          )
        : docs;
      // SECURITY (SRCH-LEAK-5): author-active gate on the bare-landing browse,
      // mirroring the LEAK-1 gate already applied to the three Meili federated-
      // hydration paths (listings/posts/jobs). `browseRecentListings` queries the
      // SAME listing corpus on the listing's own state (`status:'active' +
      // moderationStatus:'approved'`) and never re-read the owner's account state,
      // so a banned / erased seller's listings stayed discoverable on the
      // marketplace landing to other viewers — the very leak the gate closes, on a
      // different read path. Re-use the shared `inactiveOwnerIds` helper: one
      // batched indexed `$in` over the distinct owners on this page, fail-closed
      // (an owner not returned as active — banned, deactivated, or a missing row —
      // is treated as inactive and dropped).
      const inactiveOwners = await this.inactiveOwnerIds(
        visibleDocs.map((doc) => String(doc.ownerUserId)),
      );
      const activeDocs =
        inactiveOwners.size === 0
          ? visibleDocs
          : visibleDocs.filter((doc) => !inactiveOwners.has(String(doc.ownerUserId)));
      // Decrement the corpus `total` by the count dropped here so the landing's
      // infinite-scroll `hasMore` is not inflated by hidden (banned-owner) cards,
      // clamped so it never falls below the remaining visible length (mirrors the
      // SRCH-LEAK-2 clamp). `total` stays an approximation across other pages (the
      // corpus count is not author-active filtered), which is acceptable for a
      // landing browse — the same approximation the over-limit suppression note
      // above already documents.
      // CN-SRCH-7 (feed harden Bucket 9): drop listings whose seller is blocked
      // (either direction) for the viewer, mirroring the block gate every other
      // read applies. This bare-landing browse never threaded a viewer before, so
      // a blocked seller's products stayed visible on the marketplace landing.
      // Skipped when there is no viewer (logged-out landing) or no block filter.
      const blockedDocs =
        this.blockFilter && opts.viewerUserId
          ? this.blockFilter.filterRows(
              activeDocs,
              (doc) => String(doc.ownerUserId),
              await this.blockFilter.getBlockedUserIds(opts.viewerUserId),
            )
          : activeDocs;
      // Subtract BOTH the inactive-owner drops AND the block drops from the corpus
      // total so the landing's infinite-scroll hasMore is not inflated by hidden
      // cards (clamped so it never falls below the remaining visible length).
      const droppedTotal = visibleDocs.length - blockedDocs.length;
      const adjustedTotal = Math.max(total - droppedTotal, blockedDocs.length);
      const signals = await this.ownerSignalsBatch(
        blockedDocs.map((doc) => String(doc.ownerUserId)),
      );
      const listings = blockedDocs.map((doc) =>
        toListingRef(doc, { verified: signals.get(String(doc.ownerUserId))?.verified }),
      );
      return { listings, total: adjustedTotal, categoryCounts, districtCounts };
    });
  }

  /**
   * Index (upsert) one listing into the `connect_listings` index. A no-op when
   * Meili is disabled or the id is invalid. A non-public listing
   * (status !== `active` OR moderationStatus !== `approved`, including
   * deleted) is *removed* from the index so search never surfaces it.
   */
  async indexListing(listingId: string | Types.ObjectId): Promise<void> {
    if (!this.meili.enabled) return;
    if (!Types.ObjectId.isValid(listingId)) return;
    const id = new Types.ObjectId(listingId);

    return this.withSpan('connect.search.indexListing', async (span) => {
      const listing = await this.listingModel
        .findById(id)
        .lean<Listing & { _id: Types.ObjectId; createdAt?: Date }>()
        .exec();

      // Missing / non-public / unapproved listings are purged from the index.
      if (!listing || listing.status !== 'active' || listing.moderationStatus !== 'approved') {
        span.setAttribute('action', 'delete');
        await this.meili.deleteDocument(CONNECT_LISTINGS_INDEX, String(id));
        return;
      }

      span.setAttribute('action', 'upsert');
      const signals = await this.ownerSignals(String(listing.ownerUserId));
      const doc = buildListingDocument(listing, signals);
      await this.meili.upsertDocuments(CONNECT_LISTINGS_INDEX, [doc]);
    });
  }

  /**
   * Bulk-index every public listing — for first provisioning of the
   * `connect_listings` index (or a rebuild after a settings change). Ensures
   * the index + its searchable attributes exist, then pages through public
   * listings upserting them. A no-op when Meili is disabled. Returns the
   * count of indexed listings.
   */
  async reindexAllListings(): Promise<number> {
    if (!this.meili.enabled) return 0;

    return this.withSpan('connect.search.reindexAllListings', async (span) => {
      await this.meili.ensureIndex(
        CONNECT_SEARCH_INDEXES.listings.uid,
        CONNECT_SEARCH_INDEXES.listings.settings,
      );

      let indexed = 0;
      for (let skip = 0; ; skip += REINDEX_PAGE_SIZE) {
        const page = await this.listingModel
          .find({ status: 'active', moderationStatus: 'approved' })
          .sort({ _id: 1 })
          .skip(skip)
          .limit(REINDEX_PAGE_SIZE)
          .lean<Array<Listing & { _id: Types.ObjectId; createdAt?: Date }>>()
          .exec();
        if (page.length === 0) break;

        const signals = await this.ownerSignalsBatch(
          page.map((listing) => String(listing.ownerUserId)),
        );
        const docs = page.map<ConnectListingDocument>((listing) =>
          buildListingDocument(listing, signals.get(String(listing.ownerUserId))),
        );
        await this.meili.upsertDocuments(CONNECT_LISTINGS_INDEX, docs);
        indexed += page.length;

        if (page.length < REINDEX_PAGE_SIZE) break;
      }

      span.setAttribute('indexedCount', indexed);
      return indexed;
    });
  }

  /**
   * Event hook — keeps the `connect_listings` index warm. `ListingService` +
   * `ListingModerationService` emit {@link CONNECT_LISTING_CHANGED} on every
   * state-changing operation (create / edit / publish / pause / remove /
   * approve / reject); this re-indexes (or de-indexes) that one listing.
   * `async: true` so a slow Meili write never blocks the listing-write
   * request thread; `indexListing` itself swallows all faults (via
   * `MeiliClient`), so this listener cannot throw.
   */
  @OnEvent(CONNECT_LISTING_CHANGED, { async: true })
  async handleListingChanged(payload: ConnectListingChangedEvent): Promise<void> {
    await this.indexListing(payload.listingId);
  }

  // ── Backends ─────────────────────────────────────────────────────────────

  /**
   * Meilisearch backend — returns the matched `User` ids for the requested page
   * plus the full corpus match `total` (`estimatedTotalHits`), the leak-free
   * source the web people-tab infinite scroll reads for `hasMore`. Runs over the
   * `/multi-search` federation primitive as a single-leg query; mirrors
   * {@link searchListingsViaMeili}'s page + total shape.
   */
  private async searchViaMeili(
    query: string,
    filters: PeopleSearchFilters,
    page: { limit: number; offset: number },
  ): Promise<{ ids: string[]; total: number }> {
    const filter = buildPeopleMeiliFilter(filters);
    const [first] = await this.meili.multiSearch([
      {
        indexUid: CONNECT_PEOPLE_INDEX,
        q: query,
        limit: page.limit,
        offset: page.offset,
        filter: filter.length > 0 ? filter : undefined,
      },
    ]);
    const hits = first?.hits ?? [];
    const ids = hits
      .map((hit) => (typeof hit.id === 'string' ? hit.id : null))
      .filter((id): id is string => Boolean(id));
    // estimatedTotalHits = the full match count (not this page); fall back to the
    // page length when Meili omitted it (mirrors searchListingsViaMeili).
    const total =
      typeof first?.estimatedTotalHits === 'number' ? first.estimatedTotalHits : ids.length;
    return { ids, total };
  }

  /**
   * Mongo-regex fallback, used when Meilisearch is not configured. The facet
   * conditions always apply; the case-insensitive text clause over public
   * `ConnectProfile.headline` / `.skills` + `User.name` is added only when a
   * query term is present (a facet-only browse has none). A `User`-name hit is
   * kept only when that user has a *public* profile that also meets the facets,
   * so a filtered search never surfaces an off-facet or hidden person. Returns
   * the matched id set capped at {@link FALLBACK_SCAN_CAP} so the caller can
   * page it in memory (searchPeople slices the requested offset/limit window);
   * the degraded Mongo path reports that capped set's size as the total.
   */
  private async searchViaMongo(query: string, filters: PeopleSearchFilters): Promise<string[]> {
    const conditions = buildPeopleMongoConditions(filters);

    const profileQuery: Record<string, unknown> = { visibility: 'public', ...conditions };
    let nameRx: RegExp | null = null;
    if (query) {
      // Escape regex metacharacters; the query is raw user input.
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      nameRx = new RegExp(safe, 'i');
      // services.title joins the same text $or so "Find a Service" recall works
      // on the no-Meili fallback (mirrors the index searchableAttributes).
      profileQuery.$or = [{ headline: nameRx }, { skills: nameRx }, { 'services.title': nameRx }];
    }

    const [profileMatches, nameMatches] = await Promise.all([
      this.profileModel
        .find(profileQuery)
        .select('userId')
        .limit(FALLBACK_SCAN_CAP)
        .lean<Array<{ userId: Types.ObjectId }>>()
        .exec(),
      nameRx
        ? this.userModel
            .find({ name: nameRx })
            .select('_id')
            .limit(FALLBACK_SCAN_CAP)
            .lean<Array<{ _id: Types.ObjectId }>>()
            .exec()
        : Promise.resolve<Array<{ _id: Types.ObjectId }>>([]),
    ]);

    const ordered: string[] = [];
    const seen = new Set<string>();
    const push = (id: string): void => {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    };

    // Profile (headline/skill) hits first, a richer Connect signal.
    for (const p of profileMatches) push(String(p.userId));

    // Name hits, kept only for users with a public profile that also satisfies
    // the facet filters.
    const nameIds = nameMatches.map((u) => u._id);
    if (nameIds.length > 0) {
      const publicNameProfiles = await this.profileModel
        .find({ userId: { $in: nameIds }, visibility: 'public', ...conditions })
        .select('userId')
        .lean<Array<{ userId: Types.ObjectId }>>()
        .exec();
      for (const p of publicNameProfiles) push(String(p.userId));
    }

    // Return up to the scan cap (not the result cap) so searchPeople can page
    // the in-memory window; the default page (limit = SEARCH_RESULT_CAP) still
    // hands the first 25 to hydration, so the un-paged callers are unchanged.
    return ordered.slice(0, FALLBACK_SCAN_CAP);
  }

  /**
   * Meilisearch listings backend -- returns the matched `Listing` ids in rank
   * order, capped, plus the tag and category facet distributions so the web
   * can rank filter chips by listing count.
   */
  private async searchListingsViaMeili(
    query: string,
    filters: ListingSearchFilters,
    page: { limit: number; offset: number },
  ): Promise<{
    ids: string[];
    total: number;
    tagCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
    districtCounts: Record<string, number>;
  }> {
    const filter = buildListingMeiliFilter(filters, { publicOnly: true });
    // The marketplace sort dropdown; an absent / deferred value folds to `recent`.
    const { meili: sort } = buildListingSort(filters.sort);
    const [first] = await this.meili.multiSearch([
      {
        indexUid: CONNECT_LISTINGS_INDEX,
        q: query,
        limit: page.limit,
        offset: page.offset,
        filter: filter.length > 0 ? filter : undefined,
        // Request facet distribution for category, tags, and district so callers
        // can render filter chips ranked by popularity (district -> the web
        // marketplace Location filter top-N chips).
        facets: ['category', 'tags', 'district'],
        // Explicit ordering when the buyer picked a sort. On a text query this
        // takes precedence at the `sort` ranking-rule step; on a facet-only
        // browse it is the sole ordering.
        sort,
      },
    ]);
    const hits = first?.hits ?? [];
    const tagCounts: Record<string, number> = first?.facetDistribution?.['tags'] ?? {};
    const categoryCounts: Record<string, number> = first?.facetDistribution?.['category'] ?? {};
    const districtCounts: Record<string, number> = first?.facetDistribution?.['district'] ?? {};
    const ids = hits
      .map((hit) => (typeof hit.id === 'string' ? hit.id : null))
      .filter((id): id is string => Boolean(id));
    // estimatedTotalHits = the full match count (not this page) -> the web's
    // infinite-scroll hasMore. Fall back to the page length if Meili omitted it.
    const total =
      typeof first?.estimatedTotalHits === 'number' ? first.estimatedTotalHits : ids.length;
    return { ids, total, tagCounts, categoryCounts, districtCounts };
  }

  /**
   * Mongo-regex fallback for listings, used when Meilisearch is not
   * configured. Always pins `status='active'` + `moderationStatus='approved'`
   * (the public gate). The case-insensitive text clause over `title` +
   * `description` is added only when a query term is present; a facet-only
   * browse skips the regex and matches purely on the conditions. Capped at
   * {@link LISTINGS_SEARCH_RESULT_CAP}.
   */
  private async searchListingsViaMongo(
    query: string,
    filters: ListingSearchFilters,
  ): Promise<string[]> {
    const conditions = buildListingMongoConditions(filters, { publicOnly: true });

    const listingQuery: Record<string, unknown> = { ...conditions };
    if (query) {
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      listingQuery.$or = [{ title: rx }, { description: rx }];
    }

    // `verified` is not a `Listing` column (it is a per-owner signal resolved at
    // hydration), so the fallback cannot filter it in the query. When the buyer
    // asks for verified-only, over-fetch up to the scan cap and let the caller's
    // post-hydration `applyVerifiedRefFilter` narrow + re-cap, so the page does
    // not silently shrink below the result cap.
    const scanLimit = filters.verified === true ? FALLBACK_SCAN_CAP : LISTINGS_SEARCH_RESULT_CAP;
    const matches = await this.listingModel
      .find(listingQuery)
      .select('_id')
      .sort(buildListingSort(filters.sort).mongo)
      .limit(scanLimit)
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return matches.map((m) => String(m._id));
  }

  // ── Feed posts (search redesign Phase B) ──────────────────────────────────

  /**
   * Public feed-post search. Returns at most {@link POSTS_SEARCH_RESULT_CAP}
   * render-ready post cards (author hydrated) for posts that are `public` +
   * not soft-deleted + original (non-repost). Meili-first with a Mongo-regex
   * fallback. A blank query with no facet short-circuits to `[]`.
   */
  async searchPosts(
    query: string,
    filters: PostSearchFilters = {},
    page: { limit: number; offset: number } = { limit: POSTS_SEARCH_RESULT_CAP, offset: 0 },
  ): Promise<{ posts: ConnectPostResult[]; total: number }> {
    return this.withSpan('connect.search.searchPosts', async (span) => {
      const trimmed = query.trim();
      if (!trimmed && !hasPostFilters(filters)) {
        span.setAttribute('result', 'blank-query');
        return { posts: [], total: 0 };
      }

      // Phase 3 (progressive loading): posts now page like people / listings. The
      // engine reports the full corpus match `total` (estimatedTotalHits); the
      // Mongo fallback pages its capped set in memory. `page` is part of the Meili
      // cache key so each page caches separately (engine ids + total only, never
      // the hydrated cards — the block + author-active gates re-run per request).
      let ids: string[];
      let total: number;
      if (this.meili.enabled) {
        const result = await this.withMeiliCache('posts', { q: trimmed, f: filters, p: page }, () =>
          this.searchPostsViaMeili(trimmed, filters, page),
        );
        ids = result.ids;
        total = result.total;
      } else {
        const allIds = await this.searchPostsViaMongo(trimmed, filters);
        total = allIds.length;
        ids = allIds.slice(page.offset, page.offset + page.limit);
      }

      span.setAttributes({
        backend: this.meili.enabled ? 'meili' : 'mongo',
        matchCount: ids.length,
      });
      if (ids.length === 0) return { posts: [], total };

      // Hydrate from Mongo in the search-ranking order, RE-PINNING the public
      // gate so a stale index row (between a visibility flip / delete and the
      // next reindex) can never leak a now-private or deleted post.
      const docs = await this.postModel
        .find({
          _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
          visibility: 'public',
          deletedAt: null,
          repostOf: null,
        })
        .lean<Array<Post & { _id: Types.ObjectId }>>()
        .exec();
      const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
      const orderedAll = ids
        .map((id) => byId.get(id))
        .filter((doc): doc is Post & { _id: Types.ObjectId } => Boolean(doc));
      // SECURITY (SRCH-LEAK-1 / SRCH-LEAK-4): author-active gate. Drop any post
      // whose author account is erased / banned / deactivated (`isActive=false`),
      // re-read LIVE from `User` in one batched `$in`. Erasure de-indexes the
      // person but a public, non-deleted post re-pins on the post's own state and
      // would otherwise stay findable; this also closes the staleness window.
      const inactiveAuthors = await this.inactiveOwnerIds(
        orderedAll.map((doc) => String(doc.authorId)),
      );
      const ordered = (
        inactiveAuthors.size === 0
          ? orderedAll
          : orderedAll.filter((doc) => !inactiveAuthors.has(String(doc.authorId)))
      ).map((doc) => toPostRef(doc));

      // Author hydration through the one canonical people-card path (batched,
      // never N+1), so the post card shows the author identically to elsewhere.
      const authorIds = [...new Set(ordered.map((p) => p.authorId))];
      const people = await this.connectProfileService.getPeopleByIds(authorIds);
      const authorMap = new Map(people.map((p) => [p.userId, p]));

      const results: ConnectPostResult[] = ordered.map((p) => ({
        ...p,
        author: authorMap.get(p.authorId) ?? null,
      }));
      span.setAttribute('resultCount', results.length);
      return { posts: results, total };
    });
  }

  /**
   * Meilisearch backend for posts — returns the matched post ids for the page
   * plus the full corpus match `total` (estimatedTotalHits), mirroring the people
   * `searchViaMeili`. The `total` is leak-corrected in the federated layer.
   */
  private async searchPostsViaMeili(
    query: string,
    filters: PostSearchFilters,
    page: { limit: number; offset: number },
  ): Promise<{ ids: string[]; total: number }> {
    const filter = buildPostMeiliFilter(filters);
    const [first] = await this.meili.multiSearch([
      {
        indexUid: CONNECT_POSTS_INDEX,
        q: query,
        limit: page.limit,
        offset: page.offset,
        filter: filter.length > 0 ? filter : undefined,
      },
    ]);
    const hits = first?.hits ?? [];
    const ids = hits
      .map((hit) => (typeof hit.id === 'string' ? hit.id : null))
      .filter((id): id is string => Boolean(id));
    const total =
      typeof first?.estimatedTotalHits === 'number' ? first.estimatedTotalHits : ids.length;
    return { ids, total };
  }

  /**
   * Mongo-regex fallback for posts. Always pins the public gate (public + not
   * deleted + original) via {@link buildPostMongoConditions}; the case-
   * insensitive text clause over `body` + `hashtags` is added only when a query
   * term is present. Capped at {@link POSTS_SEARCH_RESULT_CAP}.
   */
  private async searchPostsViaMongo(query: string, filters: PostSearchFilters): Promise<string[]> {
    const postQuery: Record<string, unknown> = { ...buildPostMongoConditions(filters) };
    if (query) {
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      postQuery.$or = [{ body: rx }, { hashtags: rx }];
    }
    const matches = await this.postModel
      .find(postQuery)
      .select('_id')
      .sort({ createdAt: -1 })
      .limit(POSTS_SEARCH_RESULT_CAP)
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return matches.map((m) => String(m._id));
  }

  /**
   * Index (upsert) one post into `connect_posts`. A no-op when Meili is disabled
   * or the id is invalid. A non-public / soft-deleted / repost post is REMOVED
   * from the index so search never surfaces a private post or a repost duplicate.
   */
  async indexPost(postId: string | Types.ObjectId): Promise<void> {
    if (!this.meili.enabled) return;
    if (!Types.ObjectId.isValid(postId)) return;
    const id = new Types.ObjectId(postId);

    return this.withSpan('connect.search.indexPost', async (span) => {
      const post = await this.postModel
        .findById(id)
        .lean<Post & { _id: Types.ObjectId; createdAt?: Date }>()
        .exec();

      if (!post || post.visibility !== 'public' || post.deletedAt || post.repostOf) {
        span.setAttribute('action', 'delete');
        await this.meili.deleteDocument(CONNECT_POSTS_INDEX, String(id));
        return;
      }
      span.setAttribute('action', 'upsert');
      await this.meili.upsertDocuments(CONNECT_POSTS_INDEX, [buildPostDocument(post)]);
    });
  }

  /**
   * Bulk-index every public + non-deleted + original post — for first
   * provisioning of `connect_posts` (or a rebuild after a settings change). A
   * no-op when Meili is disabled. Returns the count of indexed posts.
   */
  async reindexAllPosts(): Promise<number> {
    if (!this.meili.enabled) return 0;

    return this.withSpan('connect.search.reindexAllPosts', async (span) => {
      await this.meili.ensureIndex(
        CONNECT_SEARCH_INDEXES.posts.uid,
        CONNECT_SEARCH_INDEXES.posts.settings,
      );

      let indexed = 0;
      for (let skip = 0; ; skip += REINDEX_PAGE_SIZE) {
        const page = await this.postModel
          .find({ visibility: 'public', deletedAt: null, repostOf: null })
          .sort({ _id: 1 })
          .skip(skip)
          .limit(REINDEX_PAGE_SIZE)
          .lean<Array<Post & { _id: Types.ObjectId; createdAt?: Date }>>()
          .exec();
        if (page.length === 0) break;

        await this.meili.upsertDocuments(
          CONNECT_POSTS_INDEX,
          page.map((post) => buildPostDocument(post)),
        );
        indexed += page.length;
        if (page.length < REINDEX_PAGE_SIZE) break;
      }

      span.setAttribute('indexedCount', indexed);
      return indexed;
    });
  }

  /**
   * Event hook — keeps `connect_posts` warm. `FeedService` emits
   * {@link CONNECT_POST_CHANGED} on every post create / edit / delete; this
   * re-indexes (or de-indexes) that one post. `async: true` so a slow Meili
   * write never blocks the post-write request; `indexPost` swallows all faults
   * (via `MeiliClient`), so this listener cannot throw.
   */
  @OnEvent(CONNECT_POST_CHANGED, { async: true })
  async handlePostChanged(payload: ConnectPostChangedEvent): Promise<void> {
    await this.indexPost(payload.postId);
  }

  // ── Jobs vertical (Phase 5) ────────────────────────────────────────────────

  /**
   * Public job search. Returns at most {@link JOBS_SEARCH_RESULT_CAP} render-ready
   * job cards for OPEN jobs. Meili-first with a Mongo-regex fallback. A blank
   * query with no facet short-circuits to `[]`. Re-pins `status: 'open'` on
   * hydration so a stale index row cannot leak a closed / filled job.
   */
  async searchJobs(
    query: string,
    filters: JobSearchFilters = {},
    page: { limit: number; offset: number } = { limit: JOBS_SEARCH_RESULT_CAP, offset: 0 },
  ): Promise<{ jobs: ConnectJobRef[]; total: number }> {
    return this.withSpan('connect.search.searchJobs', async (span) => {
      const trimmed = query.trim();
      if (!trimmed && !hasJobFilters(filters)) {
        span.setAttribute('result', 'blank-query');
        return { jobs: [], total: 0 };
      }

      // Phase 3 (progressive loading): jobs now page like posts / people / listings.
      // The engine reports the full corpus match `total` (estimatedTotalHits); the
      // Mongo fallback pages its capped set in memory. `page` is part of the Meili
      // cache key so each page caches separately (engine ids + total only, never
      // the hydrated cards — the block + author-active gates re-run per request).
      let ids: string[];
      let total: number;
      if (this.meili.enabled) {
        const result = await this.withMeiliCache('jobs', { q: trimmed, f: filters, p: page }, () =>
          this.searchJobsViaMeili(trimmed, filters, page),
        );
        ids = result.ids;
        total = result.total;
      } else {
        const allIds = await this.searchJobsViaMongo(trimmed, filters);
        total = allIds.length;
        ids = allIds.slice(page.offset, page.offset + page.limit);
      }

      span.setAttributes({
        backend: this.meili.enabled ? 'meili' : 'mongo',
        matchCount: ids.length,
      });
      if (ids.length === 0) return { jobs: [], total };

      const docs = await this.jobModel
        .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, status: 'open' })
        .lean<Array<Job & { _id: Types.ObjectId }>>()
        .exec();
      const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
      const orderedAll = ids
        .map((id) => byId.get(id))
        .filter((doc): doc is Job & { _id: Types.ObjectId } => Boolean(doc));
      // SECURITY (SRCH-LEAK-1 / SRCH-LEAK-4): author-active gate. Drop any job
      // whose owning company account is erased / banned / deactivated
      // (`isActive=false`), re-read LIVE from `User` in one batched `$in`. A
      // banned employer's open job ad re-pins on the job's own `status: 'open'`
      // and would otherwise stay findable; this also closes the staleness window.
      const inactiveOwners = await this.inactiveOwnerIds(
        orderedAll.map((doc) => String(doc.companyUserId)),
      );
      const ordered = (
        inactiveOwners.size === 0
          ? orderedAll
          : orderedAll.filter((doc) => !inactiveOwners.has(String(doc.companyUserId)))
      ).map((doc) => toJobRef(doc));
      span.setAttribute('resultCount', ordered.length);
      return { jobs: ordered, total };
    });
  }

  /**
   * Meilisearch backend for jobs — the page ids + the full corpus match `total`
   * (estimatedTotalHits), mirroring the posts / people `*ViaMeili`. The `total`
   * is leak-corrected in the federated layer.
   */
  private async searchJobsViaMeili(
    query: string,
    filters: JobSearchFilters,
    page: { limit: number; offset: number },
  ): Promise<{ ids: string[]; total: number }> {
    const filter = buildJobMeiliFilter(filters);
    const [first] = await this.meili.multiSearch([
      {
        indexUid: CONNECT_JOBS_INDEX,
        q: query,
        limit: page.limit,
        offset: page.offset,
        filter: filter.length > 0 ? filter : undefined,
      },
    ]);
    const hits = first?.hits ?? [];
    const ids = hits
      .map((hit) => (typeof hit.id === 'string' ? hit.id : null))
      .filter((id): id is string => Boolean(id));
    const total =
      typeof first?.estimatedTotalHits === 'number' ? first.estimatedTotalHits : ids.length;
    return { ids, total };
  }

  /** Mongo-regex fallback for jobs. Pins `status: 'open'` via the conditions. */
  private async searchJobsViaMongo(query: string, filters: JobSearchFilters): Promise<string[]> {
    const jobQuery: Record<string, unknown> = { ...buildJobMongoConditions(filters) };
    if (query) {
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      // Mirror the Meili searchableAttributes (title/description/category/role)
      // so the no-Meili fallback also finds a custom trade/occupation term.
      jobQuery.$or = [{ title: rx }, { description: rx }, { category: rx }, { role: rx }];
    }
    const matches = await this.jobModel
      .find(jobQuery)
      .select('_id')
      .sort({ createdAt: -1 })
      .limit(JOBS_SEARCH_RESULT_CAP)
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return matches.map((m) => String(m._id));
  }

  /**
   * Index (upsert) one job into `connect_jobs`. A no-op when Meili is disabled or
   * the id is invalid. A non-open (closed / filled) job is REMOVED from the index
   * so search never surfaces a job that is no longer hiring.
   */
  async indexJob(jobId: string | Types.ObjectId): Promise<void> {
    if (!this.meili.enabled) return;
    if (!Types.ObjectId.isValid(jobId)) return;
    const id = new Types.ObjectId(jobId);

    return this.withSpan('connect.search.indexJob', async (span) => {
      const job = await this.jobModel
        .findById(id)
        .lean<Job & { _id: Types.ObjectId; createdAt?: Date }>()
        .exec();

      if (!job || job.status !== 'open') {
        span.setAttribute('action', 'delete');
        await this.meili.deleteDocument(CONNECT_JOBS_INDEX, String(id));
        return;
      }
      span.setAttribute('action', 'upsert');
      await this.meili.upsertDocuments(CONNECT_JOBS_INDEX, [buildJobDocument(job)]);
    });
  }

  /**
   * Bulk-index every open job — for first provisioning of `connect_jobs` (or a
   * rebuild after a settings change). A no-op when Meili is disabled. Returns the
   * count of indexed jobs.
   */
  async reindexAllJobs(): Promise<number> {
    if (!this.meili.enabled) return 0;

    return this.withSpan('connect.search.reindexAllJobs', async (span) => {
      await this.meili.ensureIndex(
        CONNECT_SEARCH_INDEXES.jobs.uid,
        CONNECT_SEARCH_INDEXES.jobs.settings,
      );

      let indexed = 0;
      for (let skip = 0; ; skip += REINDEX_PAGE_SIZE) {
        const page = await this.jobModel
          .find({ status: 'open' })
          .sort({ _id: 1 })
          .skip(skip)
          .limit(REINDEX_PAGE_SIZE)
          .lean<Array<Job & { _id: Types.ObjectId; createdAt?: Date }>>()
          .exec();
        if (page.length === 0) break;

        await this.meili.upsertDocuments(
          CONNECT_JOBS_INDEX,
          page.map((job) => buildJobDocument(job)),
        );
        indexed += page.length;
        if (page.length < REINDEX_PAGE_SIZE) break;
      }

      span.setAttribute('indexedCount', indexed);
      return indexed;
    });
  }

  /** Event hook — keeps `connect_jobs` warm on every job create / close / fill. */
  @OnEvent(CONNECT_JOB_CHANGED, { async: true })
  async handleJobChanged(payload: ConnectJobChangedEvent): Promise<void> {
    await this.indexJob(payload.jobId);
  }

  // ── Storefronts vertical (SRCH-VERT-1) ─────────────────────────────────────

  /**
   * Public storefront (shop) search. Returns at most
   * {@link STOREFRONTS_SEARCH_RESULT_CAP} render-ready shop cards for `public`
   * storefronts. Meili-first with a Mongo-regex fallback. A blank query with no
   * facet short-circuits to `[]`. Re-pins `visibility: 'public'` on hydration so
   * a stale index row cannot leak a hidden / connections-only shop, and applies
   * the SHARED author-active gate (`inactiveOwnerIds`) so a banned / erased
   * owner's shop is dropped exactly like listings.
   */
  async searchStorefronts(
    query: string,
    filters: StorefrontSearchFilters = {},
    page: { limit: number; offset: number } = { limit: STOREFRONTS_SEARCH_RESULT_CAP, offset: 0 },
  ): Promise<{ storefronts: ConnectStorefrontRef[]; total: number }> {
    return this.withSpan('connect.search.searchStorefronts', async (span) => {
      const trimmed = query.trim();
      if (!trimmed && !hasStorefrontFilters(filters)) {
        span.setAttribute('result', 'blank-query');
        return { storefronts: [], total: 0 };
      }
      // No model in DI (unit-test positional construction) -> nothing to hydrate.
      if (!this.storefrontModel) return { storefronts: [], total: 0 };

      // Phase 3 (progressive loading): storefronts now page like jobs / posts /
      // people / listings. The engine reports the full corpus match `total`
      // (estimatedTotalHits); the Mongo fallback pages its capped set in memory.
      // `page` is part of the Meili cache key so each page caches separately
      // (engine ids + total only, never the hydrated cards — the block +
      // author-active gates re-run per request).
      let ids: string[];
      let total: number;
      if (this.meili.enabled) {
        const result = await this.withMeiliCache(
          'storefronts',
          { q: trimmed, f: filters, p: page },
          () => this.searchStorefrontsViaMeili(trimmed, filters, page),
        );
        ids = result.ids;
        total = result.total;
      } else {
        const allIds = await this.searchStorefrontsViaMongo(trimmed, filters);
        total = allIds.length;
        ids = allIds.slice(page.offset, page.offset + page.limit);
      }

      span.setAttributes({
        backend: this.meili.enabled ? 'meili' : 'mongo',
        matchCount: ids.length,
      });
      if (ids.length === 0) return { storefronts: [], total };

      // Hydrate from Mongo in rank order, RE-PINNING the public gate so a stale
      // index row (between a visibility flip / delete and the next reindex) cannot
      // leak a now-hidden or deleted shop.
      const docs = await this.storefrontModel
        .find({
          _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
          visibility: 'public',
        })
        .lean<Array<Storefront & { _id: Types.ObjectId }>>()
        .exec();
      const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
      const orderedAll = ids
        .map((id) => byId.get(id))
        .filter((doc): doc is Storefront & { _id: Types.ObjectId } => Boolean(doc));
      // SECURITY (SRCH-LEAK-1 / SRCH-LEAK-4): author-active gate. Drop any shop
      // whose owning account is erased / banned / deactivated (`isActive=false`),
      // re-read LIVE from `User` in one batched `$in`. A banned owner's `public`
      // shop re-pins on its own visibility and would otherwise stay findable; this
      // also closes the cross-vertical staleness window before the next reindex.
      const inactiveOwners = await this.inactiveOwnerIds(
        orderedAll.map((doc) => String(doc.ownerUserId)),
      );
      const ordered = (
        inactiveOwners.size === 0
          ? orderedAll
          : orderedAll.filter((doc) => !inactiveOwners.has(String(doc.ownerUserId)))
      ).map((doc) => toStorefrontRef(doc));
      span.setAttribute('resultCount', ordered.length);
      return { storefronts: ordered, total };
    });
  }

  /**
   * Meilisearch backend for storefronts — the page ids + the full corpus match
   * `total` (estimatedTotalHits), mirroring the jobs / posts `*ViaMeili`. The
   * `total` is leak-corrected in the federated layer.
   */
  private async searchStorefrontsViaMeili(
    query: string,
    filters: StorefrontSearchFilters,
    page: { limit: number; offset: number },
  ): Promise<{ ids: string[]; total: number }> {
    const filter = buildStorefrontMeiliFilter(filters);
    const [first] = await this.meili.multiSearch([
      {
        indexUid: CONNECT_STOREFRONTS_INDEX,
        q: query,
        limit: page.limit,
        offset: page.offset,
        filter: filter.length > 0 ? filter : undefined,
      },
    ]);
    const hits = first?.hits ?? [];
    const ids = hits
      .map((hit) => (typeof hit.id === 'string' ? hit.id : null))
      .filter((id): id is string => Boolean(id));
    const total =
      typeof first?.estimatedTotalHits === 'number' ? first.estimatedTotalHits : ids.length;
    return { ids, total };
  }

  /**
   * Mongo-regex fallback for storefronts. Always pins `visibility: 'public'` via
   * {@link buildStorefrontMongoConditions}; the case-insensitive text clause over
   * `name` + `description` is added only when a query term is present. Capped.
   */
  private async searchStorefrontsViaMongo(
    query: string,
    filters: StorefrontSearchFilters,
  ): Promise<string[]> {
    if (!this.storefrontModel) return [];
    const storefrontQuery: Record<string, unknown> = {
      ...buildStorefrontMongoConditions(filters),
    };
    if (query) {
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      storefrontQuery.$or = [{ name: rx }, { description: rx }, { categories: rx }];
    }
    const matches = await this.storefrontModel
      .find(storefrontQuery)
      .select('_id')
      .sort({ createdAt: -1 })
      .limit(STOREFRONTS_SEARCH_RESULT_CAP)
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return matches.map((m) => String(m._id));
  }

  /**
   * Index (upsert) one storefront into `connect_storefronts`. A no-op when Meili
   * is disabled, the model is absent, or the id is invalid. A non-public
   * (`connections` / `hidden` / deleted) shop is REMOVED from the index so search
   * never surfaces a hidden shop.
   */
  async indexStorefront(storefrontId: string | Types.ObjectId): Promise<void> {
    if (!this.meili.enabled || !this.storefrontModel) return;
    if (!Types.ObjectId.isValid(storefrontId)) return;
    const id = new Types.ObjectId(storefrontId);

    return this.withSpan('connect.search.indexStorefront', async (span) => {
      const storefront = await this.storefrontModel
        .findById(id)
        .lean<Storefront & { _id: Types.ObjectId; createdAt?: Date }>()
        .exec();

      // Missing / non-public shops are purged from the index.
      if (!storefront || storefront.visibility !== 'public') {
        span.setAttribute('action', 'delete');
        await this.meili.deleteDocument(CONNECT_STOREFRONTS_INDEX, String(id));
        return;
      }
      span.setAttribute('action', 'upsert');
      // Demo Content scope: a shop has no own `isDemo`, so derive it from the
      // OWNER's User.isDemo (snapshotted at index time, like erpLinked on people).
      const ownerIsDemo = await this.userIsDemo(storefront.ownerUserId);
      await this.meili.upsertDocuments(CONNECT_STOREFRONTS_INDEX, [
        buildStorefrontDocument({ ...storefront, ownerIsDemo }),
      ]);
    });
  }

  /**
   * Bulk-index every public storefront — for first provisioning of
   * `connect_storefronts` (or a rebuild after a settings change). A no-op when
   * Meili is disabled / the model is absent. Returns the count of indexed shops.
   */
  async reindexAllStorefronts(): Promise<number> {
    if (!this.meili.enabled || !this.storefrontModel) return 0;

    return this.withSpan('connect.search.reindexAllStorefronts', async (span) => {
      await this.meili.ensureIndex(
        CONNECT_SEARCH_INDEXES.storefronts.uid,
        CONNECT_SEARCH_INDEXES.storefronts.settings,
      );

      let indexed = 0;
      for (let skip = 0; ; skip += REINDEX_PAGE_SIZE) {
        const page = await this.storefrontModel
          .find({ visibility: 'public' })
          .sort({ _id: 1 })
          .skip(skip)
          .limit(REINDEX_PAGE_SIZE)
          .lean<Array<Storefront & { _id: Types.ObjectId; createdAt?: Date }>>()
          .exec();
        if (page.length === 0) break;

        // Demo Content scope: batch the owners' User.isDemo so each shop's
        // demoRank reflects whether its owner is a seeded sample account.
        const demoByOwner = await this.usersIsDemoBatch(page.map((s) => s.ownerUserId));
        await this.meili.upsertDocuments(
          CONNECT_STOREFRONTS_INDEX,
          page.map<ConnectStorefrontDocument>((s) =>
            buildStorefrontDocument({
              ...s,
              ownerIsDemo: demoByOwner.get(String(s.ownerUserId)),
            }),
          ),
        );
        indexed += page.length;
        if (page.length < REINDEX_PAGE_SIZE) break;
      }

      span.setAttribute('indexedCount', indexed);
      return indexed;
    });
  }

  /**
   * Event hook — keeps `connect_storefronts` warm. `StorefrontService` emits
   * {@link CONNECT_STOREFRONT_CHANGED} on every create / edit / visibility-change
   * / delete; this re-indexes (or de-indexes) that one shop. `async: true` so a
   * slow Meili write never blocks the request; `indexStorefront` swallows all
   * faults (via `MeiliClient`), so this listener cannot throw.
   */
  @OnEvent(CONNECT_STOREFRONT_CHANGED, { async: true })
  async handleStorefrontChanged(payload: ConnectStorefrontChangedEvent): Promise<void> {
    await this.indexStorefront(payload.storefrontId);
  }

  // ── Company / institute pages vertical (SRCH-VERT-1) ───────────────────────

  /**
   * Public company / institute page search (D1 name-search jump-to). Returns at
   * most {@link PAGES_SEARCH_RESULT_CAP} render-ready page cards for `public`
   * pages. Meili-first with a Mongo-regex fallback. A blank query with no facet
   * short-circuits to `[]`. Re-pins `visibility: 'public'` on hydration so a
   * stale index row cannot leak a hidden page, and applies the SHARED
   * author-active gate (`inactiveOwnerIds`) so a banned / erased owner's page is
   * dropped exactly like listings.
   */
  async searchPages(
    query: string,
    filters: PageSearchFilters = {},
    page: { limit: number; offset: number } = { limit: PAGES_SEARCH_RESULT_CAP, offset: 0 },
  ): Promise<{ pages: ConnectPageRef[]; total: number }> {
    return this.withSpan('connect.search.searchPages', async (span) => {
      const trimmed = query.trim();
      if (!trimmed && !hasPageFilters(filters)) {
        span.setAttribute('result', 'blank-query');
        return { pages: [], total: 0 };
      }
      if (!this.companyPageModel) return { pages: [], total: 0 };

      // Phase 3 (progressive loading): company / institute pages now page like the
      // other verticals. The engine reports the full corpus match `total`
      // (estimatedTotalHits); the Mongo fallback pages its capped set in memory.
      // `page` is part of the Meili cache key so each page caches separately
      // (engine ids + total only, never the hydrated cards — the block +
      // author-active gates re-run per request).
      let ids: string[];
      let total: number;
      if (this.meili.enabled) {
        const result = await this.withMeiliCache('pages', { q: trimmed, f: filters, p: page }, () =>
          this.searchPagesViaMeili(trimmed, filters, page),
        );
        ids = result.ids;
        total = result.total;
      } else {
        const allIds = await this.searchPagesViaMongo(trimmed, filters);
        total = allIds.length;
        ids = allIds.slice(page.offset, page.offset + page.limit);
      }

      span.setAttributes({
        backend: this.meili.enabled ? 'meili' : 'mongo',
        matchCount: ids.length,
      });
      if (ids.length === 0) return { pages: [], total };

      // Hydrate from Mongo in rank order, RE-PINNING the public gate so a stale
      // index row cannot leak a now-hidden or deleted page.
      const docs = await this.companyPageModel
        .find({
          _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
          visibility: 'public',
        })
        .lean<Array<CompanyPage & { _id: Types.ObjectId }>>()
        .exec();
      const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
      const orderedAll = ids
        .map((id) => byId.get(id))
        .filter((doc): doc is CompanyPage & { _id: Types.ObjectId } => Boolean(doc));
      // SECURITY (SRCH-LEAK-1 / SRCH-LEAK-4): author-active gate. Drop any page
      // whose owning account is erased / banned / deactivated (`isActive=false`),
      // re-read LIVE from `User` in one batched `$in`. Same gate inheritance as
      // listings / shops.
      const inactiveOwners = await this.inactiveOwnerIds(
        orderedAll.map((doc) => String(doc.ownerUserId)),
      );
      const ordered = (
        inactiveOwners.size === 0
          ? orderedAll
          : orderedAll.filter((doc) => !inactiveOwners.has(String(doc.ownerUserId)))
      ).map((doc) => toPageRef(doc));
      span.setAttribute('resultCount', ordered.length);
      return { pages: ordered, total };
    });
  }

  /**
   * Meilisearch backend for company pages — the page ids + the full corpus match
   * `total` (estimatedTotalHits), mirroring the storefronts / jobs `*ViaMeili`.
   * The `total` is leak-corrected in the federated layer.
   */
  private async searchPagesViaMeili(
    query: string,
    filters: PageSearchFilters,
    page: { limit: number; offset: number },
  ): Promise<{ ids: string[]; total: number }> {
    const filter = buildPageMeiliFilter(filters);
    const [first] = await this.meili.multiSearch([
      {
        indexUid: CONNECT_PAGES_INDEX,
        q: query,
        limit: page.limit,
        offset: page.offset,
        filter: filter.length > 0 ? filter : undefined,
      },
    ]);
    const hits = first?.hits ?? [];
    const ids = hits
      .map((hit) => (typeof hit.id === 'string' ? hit.id : null))
      .filter((id): id is string => Boolean(id));
    const total =
      typeof first?.estimatedTotalHits === 'number' ? first.estimatedTotalHits : ids.length;
    return { ids, total };
  }

  /**
   * Mongo-regex fallback for company pages. Always pins `visibility: 'public'`
   * via {@link buildPageMongoConditions}; the case-insensitive text clause over
   * `name` + `about` is added only when a query term is present. Capped.
   */
  private async searchPagesViaMongo(query: string, filters: PageSearchFilters): Promise<string[]> {
    if (!this.companyPageModel) return [];
    const pageQuery: Record<string, unknown> = { ...buildPageMongoConditions(filters) };
    if (query) {
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      // Mirror the Meili searchableAttributes (name/about + the free-tag fields)
      // so the no-Meili fallback also finds an institute by a course name.
      pageQuery.$or = [
        { name: rx },
        { about: rx },
        { 'industryPanel.specialization': rx },
        { 'institutePanel.coursesOffered': rx },
      ];
    }
    const matches = await this.companyPageModel
      .find(pageQuery)
      .select('_id')
      .sort({ createdAt: -1 })
      .limit(PAGES_SEARCH_RESULT_CAP)
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return matches.map((m) => String(m._id));
  }

  /**
   * Index (upsert) one company page into `connect_pages`. A no-op when Meili is
   * disabled, the model is absent, or the id is invalid. A non-public page is
   * REMOVED from the index so search never surfaces a hidden page.
   */
  async indexCompanyPage(companyPageId: string | Types.ObjectId): Promise<void> {
    if (!this.meili.enabled || !this.companyPageModel) return;
    if (!Types.ObjectId.isValid(companyPageId)) return;
    const id = new Types.ObjectId(companyPageId);

    return this.withSpan('connect.search.indexCompanyPage', async (span) => {
      const page = await this.companyPageModel
        .findById(id)
        .lean<CompanyPage & { _id: Types.ObjectId; createdAt?: Date }>()
        .exec();

      if (!page || page.visibility !== 'public') {
        span.setAttribute('action', 'delete');
        await this.meili.deleteDocument(CONNECT_PAGES_INDEX, String(id));
        return;
      }
      span.setAttribute('action', 'upsert');
      // Demo Content scope: a page has no own `isDemo`, so derive it from the
      // OWNER's User.isDemo (snapshotted at index time, like storefronts).
      const ownerIsDemo = await this.userIsDemo(page.ownerUserId);
      await this.meili.upsertDocuments(CONNECT_PAGES_INDEX, [
        buildPageDocument({ ...page, ownerIsDemo }),
      ]);
    });
  }

  /**
   * Bulk-index every public company page — for first provisioning of
   * `connect_pages` (or a rebuild after a settings change). A no-op when Meili is
   * disabled / the model is absent. Returns the count of indexed pages.
   */
  async reindexAllCompanyPages(): Promise<number> {
    if (!this.meili.enabled || !this.companyPageModel) return 0;

    return this.withSpan('connect.search.reindexAllCompanyPages', async (span) => {
      await this.meili.ensureIndex(
        CONNECT_SEARCH_INDEXES.pages.uid,
        CONNECT_SEARCH_INDEXES.pages.settings,
      );

      let indexed = 0;
      for (let skip = 0; ; skip += REINDEX_PAGE_SIZE) {
        const page = await this.companyPageModel
          .find({ visibility: 'public' })
          .sort({ _id: 1 })
          .skip(skip)
          .limit(REINDEX_PAGE_SIZE)
          .lean<Array<CompanyPage & { _id: Types.ObjectId; createdAt?: Date }>>()
          .exec();
        if (page.length === 0) break;

        // Demo Content scope: batch the owners' User.isDemo so each page's
        // demoRank reflects whether its owner is a seeded sample account.
        const demoByOwner = await this.usersIsDemoBatch(page.map((p) => p.ownerUserId));
        await this.meili.upsertDocuments(
          CONNECT_PAGES_INDEX,
          page.map<ConnectPageDocument>((p) =>
            buildPageDocument({ ...p, ownerIsDemo: demoByOwner.get(String(p.ownerUserId)) }),
          ),
        );
        indexed += page.length;
        if (page.length < REINDEX_PAGE_SIZE) break;
      }

      span.setAttribute('indexedCount', indexed);
      return indexed;
    });
  }

  /**
   * Event hook — keeps `connect_pages` warm. `CompanyPageService` emits
   * {@link CONNECT_COMPANY_PAGE_CHANGED} on every create / edit / visibility-
   * change / delete; this re-indexes (or de-indexes) that one page.
   */
  @OnEvent(CONNECT_COMPANY_PAGE_CHANGED, { async: true })
  async handleCompanyPageChanged(payload: ConnectCompanyPageChangedEvent): Promise<void> {
    await this.indexCompanyPage(payload.companyPageId);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Demo Content scope: resolve ONE owner's seeded-sample status from
   * `User.isDemo`, for verticals whose document carries no own `isDemo`
   * (storefronts / company pages). Snapshotted at index time like `erpLinked` on
   * people. An invalid / missing user resolves to `false` (treated as real).
   */
  private async userIsDemo(userId: Types.ObjectId | string): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId)) return false;
    const user = await this.userModel
      .findById(userId)
      .select('isDemo')
      .lean<{ isDemo?: boolean } | null>()
      .exec();
    return Boolean(user?.isDemo);
  }

  /**
   * Batch {@link userIsDemo} over a set of owner ids, de-duplicating so a page of
   * one owner's pages / shops costs a single read. Returns a map keyed by the
   * string owner id; a missing owner is absent (callers default to `false`).
   */
  private async usersIsDemoBatch(
    userIds: Array<Types.ObjectId | string>,
  ): Promise<Map<string, boolean>> {
    const distinct = [...new Set(userIds.map((id) => String(id)))].filter((id) =>
      Types.ObjectId.isValid(id),
    );
    if (distinct.length === 0) return new Map();
    const users = await this.userModel
      .find({ _id: { $in: distinct.map((id) => new Types.ObjectId(id)) } })
      .select('isDemo')
      .lean<Array<{ _id: Types.ObjectId; isDemo?: boolean }>>()
      .exec();
    return new Map(users.map((u) => [String(u._id), Boolean(u.isDemo)]));
  }

  /**
   * OpenTelemetry span wrapper — mirrors `NetworkService.withSpan` /
   * `SuggestionService.withSpan`. Span attributes carry only ids / counts /
   * enums, never raw PII (the search query string is deliberately not an
   * attribute — it can contain a person's name).
   */
  private async withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
