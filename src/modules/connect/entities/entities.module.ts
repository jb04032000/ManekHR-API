import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CompanyPage, CompanyPageSchema } from './schemas/company-page.schema';
import { Storefront, StorefrontSchema } from './schemas/storefront.schema';
import { Workspace, WorkspaceSchema } from '../../workspaces/schemas/workspace.schema';
import { Follow, FollowSchema } from '../network/schemas/follow.schema';
import { Post, PostSchema } from '../feed/schemas/post.schema';
import { Job, JobSchema } from '../jobs/schemas/job.schema';
import { Listing, ListingSchema } from '../marketplace/schemas/listing.schema';
import { SellerRating, SellerRatingSchema } from '../reviews/schemas/seller-rating.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { CompanyPageService } from './services/company-page.service';
import { CompanyPageStatsService } from './services/company-page-stats.service';
import { ConnectErpLifecycleService } from './connect-erp-lifecycle.service';
import { CompanyPageController } from './controllers/company-page.controller';
import { CompanyPagePublicController } from './controllers/company-page-public.controller';
import { StorefrontService } from './services/storefront.service';
import { StorefrontController } from './controllers/storefront.controller';
import { StorefrontPublicController } from './controllers/storefront-public.controller';
import { ConnectAllowanceModule } from '../monetization/connect-allowance.module';
import { ConnectProfileModule } from '../profile/connect-profile.module';
import { ConnectReviewsModule } from '../reviews/connect-reviews.module';
import { AuditModule } from '../../audit/audit.module';
import { ConnectNetworkModule } from '../network/connect-network.module';
// Shared media-URL ownership guard (logo/banner can only be files the caller uploaded).
import { MediaOwnershipModule } from '../../uploads/media-ownership.module';
import { ConnectOverLimitModule } from '../over-limit/connect-over-limit.module';
// Notifies the entity owner when the workspace-delete cascade removes their
// ERP-linked badge (ADR-0004 / 2026-06-18). One-way import (notifications has no
// dependency on Connect entities), so no module cycle.
import { NotificationsModule } from '../../notifications/notifications.module';

/**
 * ManekHR Connect -- owned business entities (Phase 4 + 6).
 *
 * Hosts the parallel sibling entities CompanyPage + Storefront (per
 * `docs/connect/IDENTITY-MODEL.md`): person-centric, public-by-slug, with an
 * OPTIONAL per-entity ERP link. W1 lands the schemas + the CompanyPage CRUD
 * (service + admin/public controllers); the Storefront service + the
 * `Listing.storefrontId` reconciliation land in W3.
 *
 * Imports:
 *  - `ConnectAllowanceModule` for the per-person Company Page / Storefront caps.
 *  - `ConnectProfileModule` for `ErpLinkService` (the derived ERP-linked badge).
 *  - `AuditModule` for write audit. (`PostHogService` is `@Global`.)
 *
 * Exports `MongooseModule` so the W3 marketplace reconciliation can inject the
 * Storefront model.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CompanyPage.name, schema: CompanyPageSchema },
      { name: Storefront.name, schema: StorefrontSchema },
      // Read-only — `linkErpWorkspace` verifies the caller owns the workspace via
      // `isWorkspaceOwner` before linking it (ADR-0004 / 2026-06-18). The
      // WorkspacesModule owns this collection; Mongoose keys models by name on
      // the shared connection, so a local forFeature is the standard read-access
      // pattern with no coupling to that module's internals.
      { name: Workspace.name, schema: WorkspaceSchema },
      // Read-only registrations for the hub + directory stats aggregations
      // (counts only). Listing + SellerRating feed the directory cards'
      // productCount + owner rating; the canonical writers own these collections.
      { name: Follow.name, schema: FollowSchema },
      { name: Post.name, schema: PostSchema },
      { name: Job.name, schema: JobSchema },
      { name: Listing.name, schema: ListingSchema },
      { name: SellerRating.name, schema: SellerRatingSchema },
      // Read-only — the owner's `User.isDemo` powers the directory "Sample"
      // disclosure badge + the shared feed/search demo down-rank (demo-rank.ts).
      // The canonical writer (UsersModule) owns this collection.
      { name: User.name, schema: UserSchema },
    ]),
    ConnectAllowanceModule,
    ConnectProfileModule,
    AuditModule,
    // Company page follow + follower count (the Follow collection + service).
    ConnectNetworkModule,
    // Owner's seller rating aggregate on the public company page (R2).
    ConnectReviewsModule,
    // Provides MediaOwnershipService for logo/banner ownership enforcement.
    MediaOwnershipModule,
    // Over-limit suppression folded onto public storefront / company-page reads.
    // No-op under the default freeze policy.
    ConnectOverLimitModule,
    // ERP-link workspace-delete cascade notifies the entity owner (ADR-0004).
    NotificationsModule,
  ],
  controllers: [
    CompanyPageController,
    CompanyPagePublicController,
    StorefrontController,
    StorefrontPublicController,
  ],
  providers: [
    CompanyPageService,
    CompanyPageStatsService,
    StorefrontService,
    // Listens for `workspace.deleted` to clear dangling ERP links (ADR-0004).
    ConnectErpLifecycleService,
  ],
  exports: [MongooseModule, CompanyPageService, StorefrontService],
})
export class ConnectEntitiesModule {}
