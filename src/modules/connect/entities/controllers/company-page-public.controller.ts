import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../../../common/decorators/public.decorator';
import { CompanyPageService } from '../services/company-page.service';
import { CompanyPageStatsService } from '../services/company-page-stats.service';
import { StorefrontService } from '../services/storefront.service';
import { NetworkService } from '../../network/network.service';
import { BrowseCompanyPagesDto, DistinctLocationsDto } from '../dto/company-page.dto';
import { mergeBrowseCounts } from '../company-page-browse-counts.helpers';

/**
 * Public Company Page read by slug -- powers the SEO page `/company/[slug]`.
 * `@Public()` so it works logged-out (SEO + signup conversion). `hidden` pages
 * 404 here (the owner views a hidden page via the authed admin endpoint). The
 * response carries the page + the privacy-trimmed `{ linked, since }` ERP badge
 * + the page follower count (the viewer's own follow state is a separate authed
 * `:id/follow-state` call, since this endpoint is logged-out).
 */
@Controller('connect/company-pages/public')
export class CompanyPagePublicController {
  constructor(
    private readonly service: CompanyPageService,
    private readonly network: NetworkService,
    private readonly stats: CompanyPageStatsService,
    // The page's attached store lives on Storefront.companyPageId; this public
    // read powers the logged-out company page's Store section (web CompanyPageView
    // via getPublicCompanyPageStore). Visibility-gated to `public` only.
    private readonly storefronts: StorefrontService,
  ) {}

  /**
   * Batch identity resolve for the feed's page-post author block, `?ids=a,b,c`.
   * Declared BEFORE `:slug` so `/refs` is not captured as a slug. Public: page
   * name / slug / logo are public info (hidden pages are dropped by the service).
   */
  @Public()
  @Get('refs')
  getRefs(@Query('ids') ids?: string) {
    const list = (ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      // Hard cap the batch so a crafted `?ids=` with thousands of entries cannot
      // force an unbounded $in lookup. A real caller (the feed author block)
      // resolves only a page's distinct page ids, well under this. Mirrors the
      // people-lookup `.slice(0, 200)` cap on `/connect/people`.
      .slice(0, 100);
    return this.service.getRefs(list);
  }

  /**
   * Public company directory: a paginated, filterable list of `public` pages.
   * Declared before `:slug` so `/browse` is not captured as a slug. Powers the
   * in-app `/connect/companies` directory + any logged-out browse surface.
   */
  @Public()
  @Get('browse')
  async browse(@Query() query: BrowseCompanyPagesDto) {
    const result = await this.service.browse(query);
    if (result.items.length === 0) return result;
    // Merge the cross-collection signals onto each card (followers + open jobs +
    // active storefront products keyed by page id; the owner's seller rating keyed
    // by ownerUserId). Batched aggregations live in OTHER modules' collections, so
    // they run here (not in CompanyPageService) to avoid the known circular dep.
    const pageIds = result.items.map((i) => i.id);
    const ownerIds = result.items.map((i) => i.ownerUserId);
    // demoOwners rides alongside the existing owner-keyed rating lookup (one more
    // batched read, no per-row N+1): which card owners are seeded demo/sample
    // accounts, so the merge can stamp the "Sample" disclosure badge (parity with
    // the shared feed/search down-rank — both read the same User.isDemo).
    const [{ followers, openJobs }, productCounts, ratings, demoOwners] = await Promise.all([
      this.stats.countsForPages(pageIds),
      this.stats.productCountsForPages(pageIds),
      this.stats.ratingsForOwners(ownerIds),
      this.stats.demoOwners(ownerIds),
    ]);
    return {
      ...result,
      // The helper folds the maps on, defaults productCount to 0, attaches the
      // rating only when rated, stamps isDemo from the owner set, and strips the
      // internal ownerUserId.
      items: mergeBrowseCounts(
        result.items,
        followers,
        openJobs,
        productCounts,
        ratings,
        demoOwners,
      ),
    };
  }

  /**
   * Distinct district / city values for the directory location search + the
   * create/edit autocomplete. Declared before `:slug` so `/locations` is not
   * captured as a slug. Public (the directory is a public surface).
   */
  @Public()
  @Get('locations')
  distinctLocations(@Query() query: DistinctLocationsDto) {
    return this.service.distinctLocations(query.field, query.q, query.limit ?? 10);
  }

  /**
   * The public storefront attached to a page (or null). The full path is
   * `connect/company-pages/public/:pageId/store` (this controller's base is
   * `.../public`). Two path segments, so it never collides with the one-segment
   * `:slug` route. `@Public()` so a logged-out buyer sees the store card +
   * Visit-store redirect on the company page. Visibility-gated: only a `public`
   * store is returned (ownerView=false), so a `hidden`/`connections` store stays
   * off the public page. Mirrors the owner GET `:pageId/store`. Links to: web
   * getPublicCompanyPageStore.
   */
  @Public()
  @Get(':pageId/store')
  async getPublicAttachedStore(@Param('pageId') pageId: string) {
    // Guard the parent page's own visibility first: a hidden/connections page
    // must not leak its store identity to a logged-out caller hitting this path
    // directly (the UI only ever reaches it from an already-public page).
    if (!(await this.service.isPublicById(pageId))) return null;
    return this.storefronts.getAttachedStorefront(pageId, false);
  }

  /**
   * Public: company-name type-ahead for the profile experience picker. Declared
   * before `:slug` so `/search` is not captured as a slug. Mirrors the sibling
   * public reads (refs/browse/locations) — `@Public()`, no extra throttle (these
   * siblings carry none beyond the controller default).
   */
  @Public()
  @Get('search')
  search(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.service.searchByName(q ?? '', limit ? Number(limit) : 8);
  }

  @Public()
  @Get(':slug')
  async getBySlug(@Param('slug') slug: string) {
    const result = await this.service.getPublicBySlug(slug);
    const followerCount = await this.network.countCompanyPageFollowers(
      String((result.page as { _id: unknown })._id),
    );
    return { ...result, followerCount };
  }
}
