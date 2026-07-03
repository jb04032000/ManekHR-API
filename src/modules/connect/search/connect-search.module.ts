import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectProfileModule } from '../profile/connect-profile.module';
import { ConnectTagsModule } from '../tags/connect-tags.module';
import { ConnectMonetizationModule } from '../monetization/connect-monetization.module';
import { ConnectReviewsModule } from '../reviews/connect-reviews.module';
import { ConnectOverLimitModule } from '../over-limit/connect-over-limit.module';
import { Listing, ListingSchema } from '../marketplace/schemas/listing.schema';
import { Post, PostSchema } from '../feed/schemas/post.schema';
import { Job, JobSchema } from '../jobs/schemas/job.schema';
// SRCH-VERT-1: storefront + company-page models registered read-only here so
// SearchService can index + hydrate the two new verticals. The entities module
// owns the canonical CRUD; this registration just exposes the models in this
// module's DI scope (mirrors the Listing / Post / Job registrations below).
import { Storefront, StorefrontSchema } from '../entities/schemas/storefront.schema';
import { CompanyPage, CompanyPageSchema } from '../entities/schemas/company-page.schema';
// UserBlock is the canonical cross-thread block store (owned by the inbox
// module); registered here read-only so the search block-filter can suppress
// blocked authors' results, mirroring how the feed module consumes it.
import { UserBlock, UserBlockSchema } from '../inbox/schemas/user-block.schema';
import { MeiliClient } from './meili.client';
import { SearchService } from './search.service';
import { FederatedSearchService } from './federated-search.service';
import { SearchBlockFilterService } from './search-block-filter.service';
import { SearchCacheService } from './search-cache.service';
import { ConnectSearchThrottlerGuard } from './connect-search-throttler.guard';
import { SearchController } from './search.controller';

/**
 * ManekHR Connect — Search module (Phase 2, Wave 4; federated query layer S1.5).
 *
 * Owns `GET /connect/search`. `FederatedSearchService` is the entry point: it
 * runs query understanding, resolves alias -> canonical slug via the tag
 * taxonomy, fans out to each live vertical, and merges weighted result groups.
 * People is the only live vertical today and is owned by `SearchService`
 * (Meilisearch over the `/multi-search` federation, with a zero-config
 * Mongo-regex fallback) + the dependency-free `MeiliClient`.
 *
 * Imports `ConnectProfileModule` for the `ConnectProfile` / `User` models and
 * `ConnectProfileService` (the single people-card hydration path) and
 * `ConnectTagsModule` for `TagService` (alias -> slug). The Meilisearch
 * `connect_people` index is kept warm by `SearchService`'s
 * `@OnEvent('connect.profile.changed')` hook — `EventEmitterModule` is
 * `forRoot`'d in `AppModule`, so no event wiring is needed here.
 */
@Module({
  imports: [
    ConnectProfileModule,
    ConnectTagsModule,
    // ConnectAllowanceService: the per-seller verified-badge + searchPriority
    // signals denormalized onto listing index docs / search results (M2.3).
    ConnectMonetizationModule,
    // Seller rating aggregate batch-folded onto marketplace listing cards (R2).
    ConnectReviewsModule,
    // Listings model lives here too so SearchService can index + hydrate
    // listings (M1.4). The marketplace module owns the canonical CRUD; this
    // registration just exposes the model in this module's DI scope.
    // Posts model registered here so SearchService can index + search feed
    // posts (search redesign Phase B). The feed module owns the canonical CRUD;
    // this registration just exposes the model in this module's DI scope.
    // Jobs model registered here so SearchService can index + search the
    // job board (Phase 5). The jobs module owns the canonical CRUD; this
    // registration just exposes the model in this module's DI scope.
    MongooseModule.forFeature([
      { name: Listing.name, schema: ListingSchema },
      { name: Post.name, schema: PostSchema },
      { name: Job.name, schema: JobSchema },
      // SRCH-VERT-1: storefronts + company / institute pages (read-only here).
      { name: Storefront.name, schema: StorefrontSchema },
      { name: CompanyPage.name, schema: CompanyPageSchema },
      // Read-only here -- the block-filter consults user blocks so a blocked
      // author never surfaces in the viewer's search results (either direction).
      { name: UserBlock.name, schema: UserBlockSchema },
    ]),
    // Over-limit suppression post-filtered onto search + browse results
    // (hide_newest policy). No-op under the default freeze policy.
    ConnectOverLimitModule,
  ],
  controllers: [SearchController],
  providers: [
    SearchService,
    FederatedSearchService,
    SearchBlockFilterService,
    // SRCH-PERF-1 — short-TTL Redis prefix cache fronting the Meili engine. The
    // REDIS_CLIENT it consumes is provided by the @Global RedisModule (no import
    // needed); absent Redis => the cache degrades to a direct query.
    SearchCacheService,
    // SRCH-PERF-1 — per-user search rate-limit guard. MUST be a provider so Nest
    // can resolve the inherited ThrottlerGuard deps when the controller's
    // @UseGuards(ConnectSearchThrottlerGuard) instantiates it (mirrors how
    // PartyPortalModule registers PortalThrottlerGuard).
    ConnectSearchThrottlerGuard,
    MeiliClient,
  ],
  exports: [SearchService],
})
export class ConnectSearchModule {}
