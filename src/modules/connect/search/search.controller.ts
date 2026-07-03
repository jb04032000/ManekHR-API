import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FederatedSearchService } from './federated-search.service';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { RecentListingsQueryDto } from './dto/recent-listings-query.dto';
import { ConnectSearchThrottlerGuard } from './connect-search-throttler.guard';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by the global `JwtAuthGuard` — `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `/connect/search` — Connect federated search (Phase 2, Wave 4; S1.5).
 *
 * Authed (the global `JwtAuthGuard`; no `@Public`) — the search surface is for
 * signed-in members. `FederatedSearchService` runs query understanding, the
 * alias -> slug fold, per-vertical fan-out, and emits its own OTel spans +
 * search telemetry, so the controller is a thin pass-through.
 */
@LegacyUnclassified()
@Controller('connect/search')
export class SearchController {
  constructor(
    private readonly federatedSearch: FederatedSearchService,
    // Must NOT be named `search`: that would create an instance property
    // `this.search` that shadows the `@Get()` route handler method below
    // (also `search`), so Nest resolves the handler to this object instead of
    // the function and throws `callback.apply is not a function` (500 on every
    // GET /connect/search). Keep this `searchService`.
    private readonly searchService: SearchService,
  ) {}

  /**
   * Recent public listings for the marketplace landing (before any query /
   * facet). Separate from the federated search, which returns empty for a blank
   * query; this powers "show products by default" on `/connect/marketplace`.
   */
  @Get('listings/recent')
  @UseGuards(ConnectSearchThrottlerGuard)
  @Throttle({ 'connect-search': { limit: 120, ttl: 60_000 } })
  browseRecentListings(@Req() req: AuthedRequest, @Query() query: RecentListingsQueryDto) {
    // CN-SRCH-7: thread the viewer so the service drops a blocked seller's cards
    // on the marketplace landing (every other read applies this block gate).
    return this.searchService.browseRecentListings({
      limit: query.limit,
      offset: query.offset,
      viewerUserId: req.user.sub,
    });
  }

  /**
   * Federated search — `?q=&type=&skills=&district=&openToWork=`. Returns the
   * federated envelope: `results` (the primary people vertical, back-compat),
   * `type`, the understood `query`, and per-vertical `groups`. A blank `q` with
   * no facet resolves to an empty envelope.
   */
  @Get()
  @UseGuards(ConnectSearchThrottlerGuard)
  @Throttle({ 'connect-search': { limit: 120, ttl: 60_000 } })
  async search(@Req() req: AuthedRequest, @Query() query: SearchQueryDto) {
    return this.federatedSearch.search(
      {
        q: query.q,
        type: query.type,
        skills: query.skills,
        district: query.district,
        openToWork: query.openToWork,
        // "Find a Service" provider filter -> people with "Providing services" on.
        providingServices: query.providingServices,
        // Listings facets (M1.4.2) + the posts content-kind facet. These were
        // present on the DTO + consumed by the service but not forwarded here,
        // so the listings filter panel never actually filtered; fixed alongside
        // adding the posts `kind` facet.
        category: query.category,
        // Multi-category set for a blended listings browse (e.g. /connect/services
        // shows ALL service categories at once). When set, supersedes `category`.
        categoryIn: query.categoryIn,
        priceMin: query.priceMin,
        priceMax: query.priceMax,
        kind: query.kind,
        tags: query.tags,
        // "Verified sellers only" toggle + the sort dropdown for the listings
        // vertical. Forwarded so the marketplace filter/sort actually apply.
        verified: query.verified,
        sort: query.sort,
        // Active-vertical pagination (the infinite scroll). The focused single
        // vertical pages — listings tab, or people tab (Phase 2); absent -> the
        // vertical's default (the typeahead / blended `all` preview).
        limit: query.limit,
        offset: query.offset,
        // SRCH-VERT-1: the company-page kind facet (institute narrow / label) for
        // the pages vertical. Storefronts + pages reuse the shared `district`
        // facet already forwarded above.
        pageKind: query.pageKind,
      },
      req.user.sub,
    );
  }
}
