import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

// Schemas
import { AdPlacement, AdPlacementSchema } from './schemas/ad-placement.schema';
import { AdCampaign, AdCampaignSchema } from './schemas/ad-campaign.schema';
import { AdSet, AdSetSchema } from './schemas/ad-set.schema';
import { AdCreative, AdCreativeSchema } from './schemas/ad-creative.schema';
import { AdImpression, AdImpressionSchema } from './schemas/ad-impression.schema';
import { AdClick, AdClickSchema } from './schemas/ad-click.schema';
import { AdvertiserWallet, AdvertiserWalletSchema } from './schemas/advertiser-wallet.schema';
import { AdWalletLedger, AdWalletLedgerSchema } from './schemas/ad-wallet-ledger.schema';
import { AdWalletTopup, AdWalletTopupSchema } from './schemas/ad-wallet-topup.schema';
import { AdDailyRollup, AdDailyRollupSchema } from './schemas/ad-daily-rollup.schema';
import {
  ConnectPricingConfig,
  ConnectPricingConfigSchema,
} from './schemas/connect-pricing-config.schema';
import { Listing, ListingSchema } from '../marketplace/schemas/listing.schema';
import { Job, JobSchema } from '../jobs/schemas/job.schema';
import { Post, PostSchema } from '../feed/schemas/post.schema';
import { Rfq, RfqSchema } from '../rfq/schemas/rfq.schema';
import { UserBlock, UserBlockSchema } from '../inbox/schemas/user-block.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';

// Services
import { WalletService } from './services/wallet.service';
import { WalletTopupCheckoutService } from './services/wallet-topup-checkout.service';
import { FrequencyCapService } from './services/frequency-cap.service';
import { AdFairnessService } from './services/ad-fairness.service';
import { AdProfileService, AD_PROFILE_SOURCE } from './services/ad-profile.service';
import { AudienceService, AUDIENCE_COUNTER } from './services/audience.service';
import { BoostService, ROLLUP_READER } from './services/boost.service';
import { JobBoostResolverService } from './services/job-boost-resolver.service';
import {
  AdDecisionService,
  PLACEMENT_REPO,
  CANDIDATE_REPO,
  PROFILE_REPO,
  FREQ_CAP_REPO,
  PACING_REPO,
  IMPRESSION_OPENER,
  BLOCK_REPO,
  CAMPAIGN_CAP_REPO,
  PAGE_DEDUPE_REPO,
  SUPPRESSION_REPO,
} from './services/ad-decision.service';
import {
  AdEventsService,
  IMPRESSION_REPO,
  CAMPAIGN_SPEND_REPO,
  WALLET_DEBITER,
  CLICK_REPO,
} from './services/ad-events.service';
import { PacingRepoRedis } from './services/pacing.repo';
import { AdsAdminService } from './services/ads-admin.service';
import { ConnectPricingConfigService } from './services/connect-pricing-config.service';

// Concrete repos
import {
  PlacementRepoMongo,
  CandidateRepoMongo,
  ImpressionOpenerMongo,
  ImpressionRepoMongo,
  CampaignSpendRepoMongo,
  ClickRepoMongo,
  RollupReaderMongo,
  BlockRepoMongo,
} from './services/ad-repos';

// Real targeting sources
import { ConnectAdProfileSource, ConnectAudienceCounter } from './services/ad-profile.source';

// Crons
import { PacingDaemon } from './crons/pacing.daemon';
import { ReconcileCron } from './crons/reconcile.cron';
import { RollupCron } from './crons/rollup.cron';

// Controllers
import { BoostController } from './controllers/boost.controller';
import { WalletController } from './controllers/wallet.controller';
import { AudienceController } from './controllers/audience.controller';
import { DecideController } from './controllers/decide.controller';
import { AdsAdminController } from './controllers/ads-admin.controller';
import { ConnectPricingController } from './controllers/connect-pricing.controller';

// Imported modules
import { ConnectProfileModule } from '../profile/connect-profile.module';
import { AuditModule } from '../../audit/audit.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ConnectOverLimitModule } from '../over-limit/connect-over-limit.module';

/**
 * ManekHR Connect -- Ads module (Phase 1 Boost Post).
 *
 * Wires the full ads engine: wallet, boost creation, ad-decision, event
 * recording, cron pacing/reconcile/rollup, and admin review.
 *
 * DI layout:
 *   - All ads Mongoose schemas registered via MongooseModule.forFeature.
 *   - RedisModule is @Global(), so REDIS_CLIENT is already available without
 *     an explicit import here.
 *   - ScheduleModule.forRoot() is NOT registered here. The @Cron decorators on
 *     PacingDaemon/ReconcileCron/RollupCron are activated by the single global
 *     forRoot() in SalaryModule (the schedule explorer scans the whole app).
 *     Calling forRoot() per module duplicates every cron — see the imports block.
 *   - ConnectProfileModule is imported to access the ConnectProfile model
 *     (for ConnectAdProfileSource + ConnectAudienceCounter) and ErpLinkService.
 *     ConnectProfileModule exports MongooseModule (and thus the ConnectProfile
 *     model) + ErpLinkService.
 *   - AuditModule is imported for AuditService consumed by AdsAdminService.
 *
 * Interface token bindings:
 *   PLACEMENT_REPO   -> PlacementRepoMongo
 *   CANDIDATE_REPO   -> CandidateRepoMongo
 *   IMPRESSION_OPENER -> ImpressionOpenerMongo
 *   IMPRESSION_REPO  -> ImpressionRepoMongo
 *   CAMPAIGN_SPEND_REPO -> CampaignSpendRepoMongo
 *   CLICK_REPO       -> ClickRepoMongo
 *   ROLLUP_READER    -> RollupReaderMongo
 *   PROFILE_REPO     -> AdProfileService (its .get() satisfies ProfileRepo)
 *   FREQ_CAP_REPO    -> FrequencyCapService
 *   PACING_REPO      -> PacingRepoRedis
 *   WALLET_DEBITER   -> WalletService
 *   AD_PROFILE_SOURCE -> ConnectAdProfileSource
 *   AUDIENCE_COUNTER -> ConnectAudienceCounter
 *
 * Seeder: the named AdPlacement rows + the singleton pricing config are now
 *   seeded by the ledgered migration runner (ADR-0001) via
 *   `SeedConnectAdPlacementsService`, NOT an OnModuleInit hook here. This module
 *   no longer touches the DB on boot.
 */
@Module({
  imports: [
    // All ads schemas.
    MongooseModule.forFeature([
      { name: AdPlacement.name, schema: AdPlacementSchema },
      { name: AdCampaign.name, schema: AdCampaignSchema },
      { name: AdSet.name, schema: AdSetSchema },
      { name: AdCreative.name, schema: AdCreativeSchema },
      { name: AdImpression.name, schema: AdImpressionSchema },
      { name: AdClick.name, schema: AdClickSchema },
      { name: AdvertiserWallet.name, schema: AdvertiserWalletSchema },
      { name: AdWalletLedger.name, schema: AdWalletLedgerSchema },
      // Gateway-confirm-first wallet top-up intents (order -> pay -> verify).
      { name: AdWalletTopup.name, schema: AdWalletTopupSchema },
      { name: AdDailyRollup.name, schema: AdDailyRollupSchema },
      // Singleton pricing-lever config (boost bid / min budget / durations /
      // top-up presets). Read by BoostService + the public pricing controller;
      // written by the admin pricing endpoints. Seeded in onModuleInit.
      { name: ConnectPricingConfig.name, schema: ConnectPricingConfigSchema },
      // Marketplace Listing: read for the listing-boost gate (owner + approved)
      // and to link Listing.boostCampaignId (M2.1). Re-registering the model in
      // this module is safe -- @nestjs/mongoose reuses the existing connection
      // model rather than redefining it.
      { name: Listing.name, schema: ListingSchema },
      // Job: read for the job-boost gate (owner + open) and to link
      // Job.boostCampaignId (Phase 5). Re-registering the model here is safe.
      { name: Job.name, schema: JobSchema },
      // Post: read for the post-boost gate (author + public + live), to link
      // Post.boostCampaignId, and to stop a campaign when the post is deleted /
      // unpublished (BoostService + the connect.post.changed listener). Owned by
      // the feed module; re-registering the model here is safe (shared connection).
      { name: Post.name, schema: PostSchema },
      // Rfq: read for the rfq-boost gate (owner + open) and to link
      // Rfq.boostCampaignId (boost_rfq). Owned by the rfq module; re-registering
      // the model here is safe (shared connection).
      { name: Rfq.name, schema: RfqSchema },
      // UserBlock: read-only here so the auction never serves a boosted post
      // across a block, either direction (BlockRepoMongo, audit B5). Owned by the
      // inbox module; re-registering the model here is safe.
      { name: UserBlock.name, schema: UserBlockSchema },
      // User: read-only here so the auction can HARD-GATE demo/sample-owned
      // candidates out of every paid/sponsored slot (CandidateRepoMongo.top
      // batch-loads owner User.isDemo + @connect-demo email — Demo-Content Scope B).
      // Owned by the users module; re-registering the model here is safe (shared
      // connection — @nestjs/mongoose reuses the existing model).
      { name: User.name, schema: UserSchema },
    ]),
    // The @Cron jobs (PacingDaemon/ReconcileCron/RollupCron) are registered by
    // the single ScheduleModule.forRoot() in SalaryModule — the schedule explorer
    // scans EVERY provider in the app, not just providers of the module that
    // called forRoot(). forRoot() is NOT idempotent in @nestjs/schedule v6: each
    // call creates its own scheduler that re-registers all crons, so a second
    // registration here made the every-minute ads_pacing job fire twice per tick
    // (visible as duplicate single-flight "already claimed; skipping" logs).
    // Do not re-add forRoot() here.
    // ConnectProfileModule exports ErpLinkService + MongooseModule (which
    // includes the ConnectProfile model). Both are consumed by the real
    // targeting sources below.
    ConnectProfileModule,
    // AuditModule exports AuditService consumed by AdsAdminService.
    AuditModule,
    // NotificationsModule exports NotificationsService -- AdsAdminService uses it
    // to best-effort notify the advertiser when their boost is taken down.
    NotificationsModule,
    // CN-LIM-1 (feed harden Bucket 11): ConnectOverLimitModule exports
    // ConnectOverLimitService so BoostService can exclude over-limit-suppressed
    // listings/jobs from boost creation + the boostable candidate list. Over-limit
    // does not import ads, so no cycle.
    ConnectOverLimitModule,
  ],

  controllers: [
    BoostController,
    WalletController,
    AudienceController,
    DecideController,
    AdsAdminController,
    // Public read of the pricing levers for the web boost composer + wallet.
    ConnectPricingController,
  ],

  providers: [
    // ---- Core services ----
    WalletService,
    // Gateway top-up checkout. Injects RazorpayPlatformService, which is
    // provided by the @Global() BillingModule (already in the app graph via
    // SubscriptionsModule), so no BillingModule import / re-provide is needed
    // here -- same pattern as AddOnsModule's CreditPackCheckoutService.
    WalletTopupCheckoutService,
    FrequencyCapService,
    // Platform fairness controls (C4 daily campaign cap + C5 per-page dedupe),
    // bound to two tokens below; injected into AdDecisionService.
    AdFairnessService,
    AdProfileService,
    AudienceService,
    BoostService,
    // Read-only promoted-jobs resolver for the jobs board (Phase 5.1). Exported
    // (below) so the jobs module can pin active boosts WITHOUT billing/decide.
    JobBoostResolverService,
    AdDecisionService,
    AdEventsService,
    PacingRepoRedis,
    AdsAdminService,
    // Pricing-lever config service: live (admin-tunable, no-deploy) bid / min
    // budget / durations read by BoostService, and the admin GET/PUT facade.
    ConnectPricingConfigService,

    // ---- Concrete repo implementations ----
    PlacementRepoMongo,
    CandidateRepoMongo,
    ImpressionOpenerMongo,
    ImpressionRepoMongo,
    CampaignSpendRepoMongo,
    ClickRepoMongo,
    RollupReaderMongo,
    BlockRepoMongo,

    // ---- Crons ----
    PacingDaemon,
    ReconcileCron,
    RollupCron,

    // ---- Real targeting sources ----
    ConnectAdProfileSource,
    ConnectAudienceCounter,

    // ---- Interface token -> concrete impl bindings ----

    // ad-decision.service tokens
    { provide: PLACEMENT_REPO, useExisting: PlacementRepoMongo },
    { provide: CANDIDATE_REPO, useExisting: CandidateRepoMongo },
    { provide: IMPRESSION_OPENER, useExisting: ImpressionOpenerMongo },
    { provide: PROFILE_REPO, useExisting: AdProfileService },
    { provide: FREQ_CAP_REPO, useExisting: FrequencyCapService },
    { provide: PACING_REPO, useExisting: PacingRepoRedis },
    // Bidirectional block filter for the auction (audit B5).
    { provide: BLOCK_REPO, useExisting: BlockRepoMongo },
    // Platform fairness controls -- one AdFairnessService instance satisfies both
    // the daily-campaign-cap (C4) and per-page-dedupe (C5) interfaces.
    { provide: CAMPAIGN_CAP_REPO, useExisting: AdFairnessService },
    { provide: PAGE_DEDUPE_REPO, useExisting: AdFairnessService },
    // Viewer "hide this sponsored post" suppression (Phase 7d) — same instance.
    { provide: SUPPRESSION_REPO, useExisting: AdFairnessService },

    // ad-events.service tokens
    { provide: IMPRESSION_REPO, useExisting: ImpressionRepoMongo },
    { provide: CAMPAIGN_SPEND_REPO, useExisting: CampaignSpendRepoMongo },
    { provide: CLICK_REPO, useExisting: ClickRepoMongo },
    { provide: WALLET_DEBITER, useExisting: WalletService },

    // boost.service token
    { provide: ROLLUP_READER, useExisting: RollupReaderMongo },

    // ad-profile.service token -> real ConnectProfile-backed source
    { provide: AD_PROFILE_SOURCE, useExisting: ConnectAdProfileSource },

    // audience.service token -> real ConnectProfile-backed counter
    { provide: AUDIENCE_COUNTER, useExisting: ConnectAudienceCounter },
  ],

  // Exported so the Connect monetization module's included-credits grant cron
  // can inject the shipped wallet without re-registering it (one WalletService
  // instance, one set of wallet/ledger model bindings).
  //
  // JobBoostResolverService is exported so the jobs module (ConnectJobsModule)
  // can render the read-only "Promoted" block. Exports are kept narrow (only the
  // wallet + this resolver) so JobsModule does not gain decide/billing surface.
  exports: [WalletService, JobBoostResolverService],
})
// No OnModuleInit / DB writes on boot. The ad-placement slots + pricing-config
// singleton are seeded by the ledgered migration runner (ADR-0001) via
// `src/migrations/seed-connect-ad-placements.ts`. Do NOT re-add a boot seeder
// here on merge — that's exactly the every-boot pattern Finding 3 removed.
export class AdsModule {}
