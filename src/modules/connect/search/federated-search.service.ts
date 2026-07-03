import { Injectable, Optional } from '@nestjs/common';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { SearchService, type ConnectPostResult } from './search.service';
import { TagService } from '../tags/tag.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { understandQuery } from './query-understanding';
import {
  VERTICAL_WEIGHTS,
  orderGroupsByWeight,
  mergePeopleFacets,
  mergeListingFacets,
  composeSearchText,
} from './federated-search.helpers';
import { hasPeopleFilters } from './people-search.helpers';
import { hasListingFilters, type ConnectListingRef } from './listing-search.helpers';
import { hasJobFilters, type ConnectJobRef, type JobSearchFilters } from './job-search.helpers';
import {
  hasStorefrontFilters,
  type ConnectStorefrontRef,
  type StorefrontSearchFilters,
} from './storefront-search.helpers';
import {
  hasPageFilters,
  type ConnectPageRef,
  type PageSearchFilters,
  type ConnectPageKind,
} from './page-search.helpers';
import { ReviewService } from '../reviews/review.service';
import { SearchBlockFilterService } from './search-block-filter.service';
import type { ConnectPersonRef } from '../profile/connect-profile.service';
import type { ConnectSearchType } from './dto/search-query.dto';
// ListingCategory import removed: category is now an open string, not a union type.
import type { PostKind } from '../feed/schemas/post.schema';

/** The request shape `GET /connect/search` resolves to (validated by the DTO). */
export interface FederatedSearchInput {
  q?: string;
  type?: ConnectSearchType;
  skills?: string[];
  district?: string;
  openToWork?: boolean;
  /** "Find a Service" provider filter -> members with "Providing services" on. */
  providingServices?: boolean;
  /** Canonical category slug -- any of the 8 known slugs or a custom term. */
  category?: string;
  /** A SET of canonical category slugs (OR semantics) for a blended listings browse
   *  (e.g. /connect/services shows ALL service categories). Supersedes `category`. */
  categoryIn?: string[];
  priceMin?: number;
  priceMax?: number;
  /** Posts content-kind facet (text / photo / video / document / voice). */
  kind?: PostKind;
  /** Canonical tag slugs to filter listings by. Each slug AND-narrows the result set. */
  tags?: string[];
  /** "Verified sellers only" toggle for the listings vertical. Only `true` narrows. */
  verified?: boolean;
  /** Listings sort key (the marketplace dropdown); defaults to `recent` server-side. */
  sort?: string;
  /** Page size for the ACTIVE single vertical's infinite scroll — listings tab,
   *  or people tab (Phase 2). Omitted -> the vertical's own default (the
   *  typeahead / `type=all` preview callers stay unchanged). */
  limit?: number;
  /** Page offset (skip N) for the active single vertical. Pairs with `limit`. */
  offset?: number;
  /** SRCH-VERT-1: company-page kind facet (the institute narrow / label). Pages vertical only. */
  pageKind?: ConnectPageKind;
}

/**
 * One vertical's slice of a federated result. Discriminated by `type` so a
 * consumer narrows the row shape from the tag: people groups carry
 * `ConnectPersonRef[]`, listing groups carry `ConnectListingRef[]`.
 */
export type SearchGroup =
  | { type: 'people'; results: ConnectPersonRef[] }
  | { type: 'posts'; results: ConnectPostResult[] }
  | { type: 'listings'; results: ConnectListingRef[] }
  | { type: 'jobs'; results: ConnectJobRef[] }
  // SRCH-VERT-1: storefronts (shops) + company / institute pages.
  | { type: 'storefronts'; results: ConnectStorefrontRef[] }
  | { type: 'pages'; results: ConnectPageRef[] };

/**
 * The federated search envelope.
 *
 *   - `results` keeps the people primary at top level so the legacy Phase-2
 *     clients (`ConnectSearchBar` typeahead, the early results page) stay
 *     byte-identical when the federation widened to listings (M1.4.2).
 *   - `listings` is the listings primary at top level (M1.4.2). Empty when
 *     the active vertical is `people` only, populated when the active
 *     vertical is `listings` or `all`.
 *   - `tagCounts` is the Meilisearch facet distribution for the `tags`
 *     attribute on the listings vertical. Keys are tag slugs; values are the
 *     number of matched listings carrying that tag. Empty on the Mongo
 *     fallback path or when Meili returns no distribution. The web uses this
 *     to rank tag-filter chips by listing count.
 *   - `groups` is the per-vertical breakdown the discovery UI (S1.6)
 *     consumes; weight-ordered (people first today). Carries one group per
 *     queried vertical, even when that group is empty, so the UI can show
 *     "no people found" without losing the vertical context.
 *   - `query` echoes the understood query so the UI can render the canonical
 *     term + resolved tag chips.
 */
export interface FederatedSearchResult {
  results: ConnectPersonRef[];
  posts: ConnectPostResult[];
  listings: ConnectListingRef[];
  /** Full listings match count (all pages) - the web marketplace infinite-scroll
   *  hasMore (offset + listings.length < listingsTotal). Other verticals: not paged. */
  listingsTotal: number;
  /** Full people match count (all pages) - the web people-tab infinite-scroll
   *  hasMore (Phase 2). Leak-free (block-filtered count, clamped). 0 on a
   *  blank-q short-circuit. People vertical paging only (Phase 2). */
  peopleTotal: number;
  /** Full posts match count (all pages) - the web posts-tab infinite-scroll
   *  hasMore (Phase 3). Leak-free (block-filtered count, clamped). 0 on a
   *  blank-q short-circuit. Posts vertical paging only. */
  postsTotal: number;
  /** Full jobs match count (all pages) - the web jobs-tab infinite-scroll
   *  hasMore (Phase 3). Leak-free (block-filtered count, clamped). 0 on a
   *  blank-q short-circuit. Jobs vertical paging only. */
  jobsTotal: number;
  jobs: ConnectJobRef[];
  /** Full storefronts match count (all pages) - the web storefronts-tab infinite-scroll
   *  hasMore (Phase 3). Leak-free (block-filtered count, clamped). 0 on a blank-q
   *  short-circuit. Storefronts vertical paging only. */
  storefrontsTotal: number;
  /** SRCH-VERT-1: storefront (shop) primary at top level. Empty unless the active
   *  vertical is `storefronts` or `all`. */
  storefronts: ConnectStorefrontRef[];
  /** Full pages match count (all pages) - the web pages-tab infinite-scroll
   *  hasMore (Phase 3). Leak-free (block-filtered count, clamped). 0 on a blank-q
   *  short-circuit. Pages vertical paging only. */
  pagesTotal: number;
  /** SRCH-VERT-1: company / institute page primary at top level. Empty unless the
   *  active vertical is `pages` or `all`. */
  pages: ConnectPageRef[];
  /** Meilisearch facet distribution for listing tags ({slug: count}). Empty on Mongo fallback. */
  tagCounts: Record<string, number>;
  /** Meilisearch facet distribution for listing categories ({slug: count}). Empty on Mongo fallback. */
  categoryCounts: Record<string, number>;
  /** Meilisearch facet distribution for listing districts ({lowercased district: count}). Empty on Mongo fallback. Drives the web marketplace Location filter chips. */
  districtCounts: Record<string, number>;
  type: ConnectSearchType;
  query: { raw: string; text: string; tags: string[] };
  groups: SearchGroup[];
}

/**
 * `FederatedSearchService` — the cross-vertical query layer (S1.5).
 *
 * It is the single entry point for `GET /connect/search`. Responsibilities:
 *
 *  1. **Query understanding** (rule-based, no ML): strip `#`, extract hashtags,
 *     infer facet intent — via {@link understandQuery}.
 *  2. **Alias -> canonical slug**: resolve the hashtags through the tag
 *     taxonomy ({@link TagService.normalizeHashtags}) and fold the canonical
 *     slugs into the search text for extra recall.
 *  3. **Fan out per vertical**: delegate each in-scope vertical to its owning
 *     search service. People is the only live vertical, so it delegates to
 *     {@link SearchService.searchPeople} (which itself runs Meilisearch — over
 *     the `/multi-search` federation primitive — or the Mongo fallback, and
 *     hydrates the people cards). Listings (M1.4) and jobs (P5) join here.
 *  4. **Merge + weight**: order the result groups by per-vertical weight.
 *  5. **Telemetry**: emit a search event and, when a text query returns nothing,
 *     a zero-result event — the signal that feeds the missing-vocabulary loop.
 *
 * Person-centric throughout: every result resolves by `userId`, never a
 * workspace.
 */
@Injectable()
export class FederatedSearchService {
  private readonly tracer = trace.getTracer('connect.search');

  constructor(
    private readonly searchService: SearchService,
    private readonly tagService: TagService,
    @Optional() private readonly posthog?: PostHogService,
    /**
     * Batch-enriches marketplace listing cards with the seller rating aggregate
     * (R2) - the buyer-comparison surface. Optional so the search layer degrades
     * gracefully if the reviews module is ever absent.
     */
    @Optional() private readonly reviews?: ReviewService,
    /**
     * Viewer-contextual block-list gate (APPROVED visibility-contract change,
     * Wave 1). REQUIRED (SRCH-LEAK-3): this is a security filter — if DI ever
     * dropped the provider, an `@Optional()` injection would silently fail OPEN
     * (every vertical returned unfiltered, blocks ignored). Making it mandatory
     * means a missing block filter fails to BOOT rather than quietly disabling
     * suppression at runtime. Every fanned-out vertical is filtered by the
     * viewer's blocks before blending.
     */
    private readonly blockFilter: SearchBlockFilterService,
  ) {}

  /**
   * Fold the seller rating aggregate onto a page of listing cards (R2). One
   * batched lookup over the distinct owners on the page (no N+1); a card whose
   * owner is unrated is returned untouched (no stars).
   */
  private async enrichListingRatings(listings: ConnectListingRef[]): Promise<ConnectListingRef[]> {
    if (!this.reviews || listings.length === 0) return listings;
    const owners = [...new Set(listings.map((l) => l.ownerUserId))];
    const ratings = await this.reviews.getAggregatesFor(owners);
    if (ratings.size === 0) return listings;
    return listings.map((l) => {
      const rating = ratings.get(l.ownerUserId);
      return rating ? { ...l, rating } : l;
    });
  }

  /**
   * Run a federated search. `actorUserId` is the authenticated viewer (the
   * PostHog distinct id). A blank query with no facets short-circuits to an
   * empty result without touching any backend or emitting telemetry.
   */
  async search(input: FederatedSearchInput, actorUserId: string): Promise<FederatedSearchResult> {
    return this.withSpan('connect.search.federated', async (span) => {
      const understood = understandQuery(input.q ?? '');
      const type: ConnectSearchType = input.type ?? 'people';

      // Alias -> canonical slug, then fold the canonical slugs into the text.
      const tags =
        understood.hashtags.length > 0
          ? await this.tagService.normalizeHashtags(understood.hashtags)
          : [];
      const text = composeSearchText(understood.text, tags);

      const peopleFacets = mergePeopleFacets(
        {
          skills: input.skills,
          district: input.district,
          openToWork: input.openToWork,
          providingServices: input.providingServices,
        },
        understood.facets,
      );
      const listingFacets = mergeListingFacets({
        category: input.category,
        categoryIn: input.categoryIn,
        district: input.district,
        priceMin: input.priceMin,
        priceMax: input.priceMax,
        tags: input.tags,
        verified: input.verified,
        sort: input.sort,
      });

      const wantPeople = type === 'people' || type === 'all';
      const wantPosts = type === 'posts' || type === 'all';
      const wantListings = type === 'listings' || type === 'all';
      const wantJobs = type === 'jobs' || type === 'all';
      // SRCH-VERT-1: storefronts + pages join the fan-out.
      const wantStorefronts = type === 'storefronts' || type === 'all';
      const wantPages = type === 'pages' || type === 'all';

      // Jobs reuse the shared `category` facet (same textile taxonomy as listings).
      const jobFacets: JobSearchFilters = input.category ? { category: input.category } : {};

      // Storefronts + pages reuse the shared `district` facet; pages also take the
      // dedicated `pageKind` (business / institute) narrow. Built as clean shapes
      // so the `has*Filters` checks below see no empty fields.
      const storefrontFacets: StorefrontSearchFilters = {};
      if (input.district && input.district.trim().length > 0) {
        storefrontFacets.district = input.district;
      }
      const pageFacets: PageSearchFilters = {};
      if (input.district && input.district.trim().length > 0) {
        pageFacets.district = input.district;
      }
      if (input.pageKind) pageFacets.kind = input.pageKind;

      const hasQuery = text.length > 0;
      const hasFacets =
        (wantPeople && hasPeopleFilters(peopleFacets)) ||
        (wantListings && hasListingFilters(listingFacets)) ||
        (wantJobs && hasJobFilters(jobFacets)) ||
        (wantStorefronts && hasStorefrontFilters(storefrontFacets)) ||
        (wantPages && hasPageFilters(pageFacets)) ||
        (wantPosts && Boolean(input.kind));
      span.setAttributes({ type, hasQuery, tagCount: tags.length });

      // Nothing to search — the search box before the user has typed.
      if (!hasQuery && !hasFacets) {
        span.setAttribute('result', 'blank-query');
        return this.empty(understood.raw, text, tags, type);
      }

      // Fan out to each active vertical in parallel. Empty `Promise.resolve`
      // values are explicitly typed so TS infers the right element shape. The
      // posts leg runs with a query OR a kind facet (a kind-only browse).
      const [
        peopleSearchResult,
        postSearchResult,
        listingSearchResult,
        jobSearchResult,
        storefrontSearchResult,
        pageSearchResult,
      ] = await Promise.all([
        wantPeople
          ? // Phase 2: thread the active-vertical page (limit/offset) ONLY on the
            // focused people tab, mirroring the listings leg below. `type=all`
            // keeps the people preview at searchPeople's own default (no paging),
            // so the blended view stays a preview (Phase 1b).
            this.searchService.searchPeople(
              text,
              peopleFacets,
              type === 'people' && input.limit != null
                ? { limit: input.limit, offset: input.offset ?? 0 }
                : undefined,
            )
          : Promise.resolve<{ people: ConnectPersonRef[]; total: number }>({
              people: [],
              total: 0,
            }),
        wantPosts && (hasQuery || Boolean(input.kind))
          ? // Phase 3: thread the active-vertical page ONLY on the focused posts
            // tab, mirroring people/listings; `type=all` keeps the posts preview
            // unpaged (Phase 1b).
            this.searchService.searchPosts(
              text,
              { kind: input.kind },
              type === 'posts' && input.limit != null
                ? { limit: input.limit, offset: input.offset ?? 0 }
                : undefined,
            )
          : Promise.resolve<{ posts: ConnectPostResult[]; total: number }>({ posts: [], total: 0 }),
        wantListings
          ? // Pass the page ONLY when a caller (the marketplace) asked for one, so
            // the search-page / typeahead callers keep searchListings' own default.
            this.searchService.searchListings(
              text,
              listingFacets,
              input.limit != null ? { limit: input.limit, offset: input.offset ?? 0 } : undefined,
            )
          : Promise.resolve({
              listings: [] as ConnectListingRef[],
              total: 0,
              tagCounts: {} as Record<string, number>,
              categoryCounts: {} as Record<string, number>,
              districtCounts: {} as Record<string, number>,
            }),
        wantJobs && (hasQuery || hasJobFilters(jobFacets))
          ? // Phase 3: thread the active-vertical page ONLY on the focused jobs tab,
            // mirroring people/posts/listings; `type=all` keeps the jobs preview unpaged.
            this.searchService.searchJobs(
              text,
              jobFacets,
              type === 'jobs' && input.limit != null
                ? { limit: input.limit, offset: input.offset ?? 0 }
                : undefined,
            )
          : Promise.resolve<{ jobs: ConnectJobRef[]; total: number }>({ jobs: [], total: 0 }),
        // SRCH-VERT-1: storefronts run with a query OR a district facet. Phase 3:
        // thread the page ONLY on the focused storefronts tab (type=all stays a preview).
        wantStorefronts && (hasQuery || hasStorefrontFilters(storefrontFacets))
          ? this.searchService.searchStorefronts(
              text,
              storefrontFacets,
              type === 'storefronts' && input.limit != null
                ? { limit: input.limit, offset: input.offset ?? 0 }
                : undefined,
            )
          : Promise.resolve<{ storefronts: ConnectStorefrontRef[]; total: number }>({
              storefronts: [],
              total: 0,
            }),
        // SRCH-VERT-1: pages run with a query OR a kind/district facet. Phase 3:
        // thread the page ONLY on the focused pages tab (type=all stays a preview).
        wantPages && (hasQuery || hasPageFilters(pageFacets))
          ? this.searchService.searchPages(
              text,
              pageFacets,
              type === 'pages' && input.limit != null
                ? { limit: input.limit, offset: input.offset ?? 0 }
                : undefined,
            )
          : Promise.resolve<{ pages: ConnectPageRef[]; total: number }>({ pages: [], total: 0 }),
      ]);

      const enrichedListings = await this.enrichListingRatings(listingSearchResult.listings);
      const tagCounts = listingSearchResult.tagCounts;
      const categoryCounts = listingSearchResult.categoryCounts;
      const districtCounts = listingSearchResult.districtCounts;
      // Full listings match count (all pages) - the web marketplace infinite-scroll
      // hasMore. Other verticals are not paginated here, so only listings carry it.
      const listingsTotal = listingSearchResult.total;
      // Phase 2: the people vertical is now paginated too (the focused people tab).
      // `peopleResults` is this page's rows; `peopleTotal` is the full match count
      // (the web people-tab infinite-scroll hasMore source). Leak-corrected below.
      const peopleResults = peopleSearchResult.people;
      const peopleTotal = peopleSearchResult.total;
      // Phase 3: the posts + jobs verticals now carry a corpus total too (leak-corrected below).
      const postResults = postSearchResult.posts;
      const postsTotal = postSearchResult.total;
      const jobResults = jobSearchResult.jobs;
      const jobsTotal = jobSearchResult.total;
      const storefrontResults = storefrontSearchResult.storefronts;
      const storefrontsTotal = storefrontSearchResult.total;
      const pageResults = pageSearchResult.pages;
      const pagesTotal = pageSearchResult.total;

      // SECURITY / VISIBILITY (Wave 1, APPROVED logical change): viewer-contextual
      // block-list suppression. Applied POST-Meili, PRE-blend, to EVERY vertical
      // by author id, so a result authored by a user the viewer blocked (or who
      // blocked the viewer, either direction) is ABSENT from the response AND
      // uncounted (the group/total counts below derive from these filtered
      // arrays). Server-side only; reuses the canonical `connect_user_blocks`
      // store the feed + inbox already consult -- no new block store. Generic
      // by author-id accessor so any future vertical inherits it automatically.
      // A blank/absent blocked set is a no-op (the common case).
      const blocked = await this.blockFilter.getBlockedUserIds(actorUserId);
      const filterRows = <T>(rows: T[], authorIdOf: (row: T) => string): T[] =>
        this.blockFilter.filterRows(rows, authorIdOf, blocked);

      const peopleResultsVisible = filterRows(peopleResults, (p) => p.userId);
      const postResultsVisible = filterRows(postResults, (p) => p.authorId);
      const listingResults = filterRows(enrichedListings, (l) => l.ownerUserId);
      const jobResultsVisible = filterRows(jobResults, (j) => j.companyUserId);
      // SRCH-VERT-1: storefronts + pages inherit the SAME per-viewer block filter
      // by routing each vertical's OWNER id into the generic `filterRows` path — a
      // shop / page authored by a user the viewer blocked (either direction) is
      // ABSENT from the response AND uncounted (the group counts below derive from
      // these filtered arrays).
      const storefrontResultsVisible = filterRows(storefrontResults, (s) => s.ownerUserId);
      const pageResultsVisible = filterRows(pageResults, (p) => p.ownerUserId);

      // SECURITY (SRCH-LEAK-2): close the count-leak. `listingsTotal` is Meili's
      // corpus-wide match count and the facet distributions are corpus-wide too,
      // so a blocked seller's listings still inflate the HEADLINE total + the
      // facet chip counts even though their rows were just dropped from the page
      // above. Subtract the listings the block filter removed FROM THIS PAGE from
      // both the headline total and their matching facet buckets. We can only
      // reason about the current page (the rest of the corpus is unfetched), so:
      //   - listingsTotal: never goes below the visible array length (it stays a
      //     correct, leak-free *lower bound* that the web's infinite-scroll
      //     `hasMore` consumes safely);
      //   - facet counts: best-effort subtraction of the dropped page rows from
      //     their tag/category/district buckets — they remain corpus-wide
      //     APPROXIMATIONS (a blocked seller's listings on other, unfetched pages
      //     are not subtracted), but the headline total is leak-free, which is
      //     the contract requirement.
      const droppedListings = enrichedListings.filter((l) => !listingResults.includes(l));
      const adjustedListingsTotal =
        droppedListings.length > 0
          ? Math.max(listingsTotal - droppedListings.length, listingResults.length)
          : listingsTotal;

      // SECURITY (Phase 2, count-leak parity with listings): close the people
      // count-leak the SAME way. `peopleTotal` is the engine's corpus-wide match
      // count, so a blocked person still inflates the headline total even though
      // their row was just dropped from the page above. Subtract the people the
      // block filter removed FROM THIS PAGE; clamp so the total never falls below
      // the still-visible array length (a correct, leak-free LOWER BOUND the web's
      // people-tab infinite-scroll `hasMore` consumes safely).
      const droppedPeople = peopleResults.filter((p) => !peopleResultsVisible.includes(p));
      const adjustedPeopleTotal =
        droppedPeople.length > 0
          ? Math.max(peopleTotal - droppedPeople.length, peopleResultsVisible.length)
          : peopleTotal;
      // Phase 3: the SAME count-leak accounting for posts (the posts-tab hasMore source).
      const droppedPosts = postResults.filter((p) => !postResultsVisible.includes(p));
      const adjustedPostsTotal =
        droppedPosts.length > 0
          ? Math.max(postsTotal - droppedPosts.length, postResultsVisible.length)
          : postsTotal;
      // Phase 3: the SAME count-leak accounting for jobs (the jobs-tab hasMore source).
      const droppedJobs = jobResults.filter((j) => !jobResultsVisible.includes(j));
      const adjustedJobsTotal =
        droppedJobs.length > 0
          ? Math.max(jobsTotal - droppedJobs.length, jobResultsVisible.length)
          : jobsTotal;
      // Phase 3: the SAME count-leak accounting for storefronts (the storefronts-tab hasMore source).
      const droppedStorefronts = storefrontResults.filter(
        (s) => !storefrontResultsVisible.includes(s),
      );
      const adjustedStorefrontsTotal =
        droppedStorefronts.length > 0
          ? Math.max(storefrontsTotal - droppedStorefronts.length, storefrontResultsVisible.length)
          : storefrontsTotal;
      // Phase 3: the SAME count-leak accounting for pages (the pages-tab hasMore source).
      const droppedPages = pageResults.filter((p) => !pageResultsVisible.includes(p));
      const adjustedPagesTotal =
        droppedPages.length > 0
          ? Math.max(pagesTotal - droppedPages.length, pageResultsVisible.length)
          : pagesTotal;
      const decrementBucket = (counts: Record<string, number>, key: string | undefined): void => {
        if (!key) return;
        const k = key.toLowerCase();
        if (counts[k] != null) counts[k] = Math.max(0, counts[k] - 1);
        else if (counts[key] != null) counts[key] = Math.max(0, counts[key] - 1);
      };
      // Clone the facet maps before mutating so we never write back into a
      // possibly-shared upstream object.
      const tagCountsAdjusted = { ...tagCounts };
      const categoryCountsAdjusted = { ...categoryCounts };
      const districtCountsAdjusted = { ...districtCounts };
      for (const l of droppedListings) {
        const listingTags: string[] = l.tags ?? [];
        for (const tag of listingTags) decrementBucket(tagCountsAdjusted, tag);
        decrementBucket(categoryCountsAdjusted, l.category);
        decrementBucket(districtCountsAdjusted, l.district);
      }

      // Always include a group per queried vertical (even when empty) so the
      // UI tab strip knows the request was made; weight-ordered for `type=all`.
      const initial: SearchGroup[] = [];
      if (wantPeople) initial.push({ type: 'people', results: peopleResultsVisible });
      if (wantPosts) initial.push({ type: 'posts', results: postResultsVisible });
      if (wantListings) initial.push({ type: 'listings', results: listingResults });
      if (wantJobs) initial.push({ type: 'jobs', results: jobResultsVisible });
      if (wantStorefronts) initial.push({ type: 'storefronts', results: storefrontResultsVisible });
      if (wantPages) initial.push({ type: 'pages', results: pageResultsVisible });
      const groups = orderGroupsByWeight(initial, VERTICAL_WEIGHTS);

      const total = groups.reduce((sum, group) => sum + group.results.length, 0);
      span.setAttribute('resultCount', total);

      this.emitSearchEvents(actorUserId, { type, text, hasQuery, total });

      return {
        results: peopleResultsVisible,
        posts: postResultsVisible,
        listings: listingResults,
        // SRCH-LEAK-2: leak-free headline total + best-effort decremented facets.
        listingsTotal: adjustedListingsTotal,
        // Phase 2: leak-free people headline total (the people-tab hasMore source).
        peopleTotal: adjustedPeopleTotal,
        // Phase 3: leak-free posts headline total (the posts-tab hasMore source).
        postsTotal: adjustedPostsTotal,
        // Phase 3: leak-free jobs headline total (the jobs-tab hasMore source).
        jobsTotal: adjustedJobsTotal,
        jobs: jobResultsVisible,
        // Phase 3: leak-free storefronts headline total (the storefronts-tab hasMore source).
        storefrontsTotal: adjustedStorefrontsTotal,
        storefronts: storefrontResultsVisible,
        // Phase 3: leak-free pages headline total (the pages-tab hasMore source).
        pagesTotal: adjustedPagesTotal,
        pages: pageResultsVisible,
        tagCounts: tagCountsAdjusted,
        categoryCounts: categoryCountsAdjusted,
        districtCounts: districtCountsAdjusted,
        type,
        query: { raw: understood.raw, text, tags },
        groups,
      };
    });
  }

  /** The empty envelope for a blank query - one empty group per active vertical, no events. */
  private empty(
    raw: string,
    text: string,
    tags: string[],
    type: ConnectSearchType,
  ): FederatedSearchResult {
    const groups: SearchGroup[] = [];
    if (type === 'people' || type === 'all') groups.push({ type: 'people', results: [] });
    if (type === 'posts' || type === 'all') groups.push({ type: 'posts', results: [] });
    if (type === 'listings' || type === 'all') groups.push({ type: 'listings', results: [] });
    if (type === 'jobs' || type === 'all') groups.push({ type: 'jobs', results: [] });
    if (type === 'storefronts' || type === 'all') groups.push({ type: 'storefronts', results: [] });
    if (type === 'pages' || type === 'all') groups.push({ type: 'pages', results: [] });
    return {
      results: [],
      posts: [],
      listings: [],
      listingsTotal: 0,
      peopleTotal: 0,
      postsTotal: 0,
      jobsTotal: 0,
      jobs: [],
      storefrontsTotal: 0,
      storefronts: [],
      pagesTotal: 0,
      pages: [],
      tagCounts: {},
      categoryCounts: {},
      districtCounts: {},
      type,
      query: { raw, text, tags },
      groups,
    };
  }

  /**
   * Emit search telemetry. `search_performed` always fires for a real search;
   * `search_no_results` fires only when a TEXT query returned nothing — that is
   * the actionable missing-vocabulary signal (a facet-only browse that returns
   * nothing is not a vocabulary gap). Fire-and-forget; PostHog is a safe no-op
   * when unconfigured.
   */
  private emitSearchEvents(
    actorUserId: string,
    args: { type: ConnectSearchType; text: string; hasQuery: boolean; total: number },
  ): void {
    this.posthog?.capture({
      distinctId: actorUserId,
      event: 'connect.search_performed',
      properties: { type: args.type, hasQuery: args.hasQuery, resultCount: args.total },
    });

    if (args.hasQuery && args.total === 0) {
      this.posthog?.capture({
        distinctId: actorUserId,
        event: 'connect.search_no_results',
        properties: { type: args.type, query: args.text },
      });
    }
  }

  /** OTel span wrapper — attributes carry ids / counts / enums only, never the raw query (it can hold a name). */
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
