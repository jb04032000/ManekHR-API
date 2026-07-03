import { Module } from '@nestjs/common';
import { ConnectAllowanceModule } from './connect-allowance.module';
import { AdsModule } from '../ads/ads.module';
import { IncludedCreditsGrantCron } from './crons/included-credits-grant.cron';

/**
 * ManekHR Connect - Monetization module (Phase M0.5).
 *
 * Provides ConnectAllowanceService: the person-centric reader of a Connect
 * subscription's `connect` allowance sub-block, with a connect_free fallback.
 * Exported for the marketplace listing + lead paths (M1) and the included-
 * credits grant cron (M0.6) to consume.
 *
 * Registers the Subscription + Plan models locally so the service resolves
 * allowances by userId WITHOUT importing SubscriptionsService, which keeps the
 * workspace-owner inheritance path (an ERP concept) out of person-centric
 * Connect entirely.
 */
@Module({
  imports: [
    // ConnectAllowanceService + the Subscription/Plan models (the cron reads
    // Subscription). Extracted to ConnectAllowanceModule so profile/search can
    // import the allowance reader without the AdsModule cycle (M2.3).
    ConnectAllowanceModule,
    // Brings in the shipped person-centric ads WalletService that the grant
    // cron credits into (separate Connect wallet, shared billing engine).
    AdsModule,
  ],
  providers: [IncludedCreditsGrantCron],
  // Re-export so existing consumers of this module (ConnectSearchModule) keep
  // resolving ConnectAllowanceService unchanged.
  exports: [ConnectAllowanceModule],
})
export class ConnectMonetizationModule {}
