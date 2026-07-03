import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Subscription } from '../../../subscriptions/schemas/subscription.schema';
import { WalletService } from '../../ads/services/wallet.service';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../../common/constants/cron.constants';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';

/**
 * M0.6 - Connect included-boost-credit grant cron.
 *
 * Fires daily at midnight IST. For every active, person-centric Connect
 * subscription whose plan includes boost credits
 * (`appliedEntitlements.connect.includedBoostCredits > 0`) it:
 *   1. sweeps any prior-cycle grant that has expired (expireGrants), then
 *   2. grants includedBoostCredits into the person's ads wallet for the current
 *      cycle, idempotent on `grant-<subId>-<currentPeriodStart>` so a daily
 *      re-run inside the same cycle is a no-op and a new cycle re-grants.
 *
 * Granted credits land in the wallet's separate, expiring grantBalance bucket
 * (Option A): spent before purchased credits and expiring at `currentPeriodEnd`.
 * Purchased (PAYG top-up) credits are never touched here.
 *
 * Person-centric: Connect subscriptions have `workspaceId: null` and are
 * resolved purely by `userId` -- no workspace-owner inheritance. A daily cadence
 * (not exact cycle boundary) is sufficient because the grant is idempotent per
 * cycle and the prior grant is swept on expiry; the catch-up lands within 24h.
 */
@Injectable()
export class IncludedCreditsGrantCron {
  private readonly logger = new Logger(IncludedCreditsGrantCron.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    private readonly wallet: WalletService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Connect included boost-credit grant (M0.6)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily at midnight IST - grant the cycle's included boost credits.
   * Idempotent:  YES - WalletService.grant is keyed on
   *              `grant-<subId>-<currentPeriodStart>`, so a same-cycle re-run is a
   *              no-op and a new cycle re-grants; expireGrants sweeps prior cycle.
   * Reads:       subscriptions (Connect, active, includedBoostCredits > 0)
   * Writes:      ads wallet grantBalance (expiring credits)
   * Missed run:  Self-heals - the catch-up grant lands within 24h of cycle start.
   * Owner:       connect/monetization
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT, { timeZone: CRON_TIMEZONES.IST })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.CONNECT_INCLUDED_CREDITS, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const subs = await this.subscriptionModel
      .find({
        status: 'active',
        product: 'connect',
        'appliedEntitlements.connect.includedBoostCredits': { $gt: 0 },
      })
      .lean()
      .exec();

    if (subs.length === 0) {
      this.logger.debug('No active Connect subscriptions with included boost credits');
      return;
    }

    let granted = 0;
    for (const sub of subs) {
      const userId = String((sub as { userId: Types.ObjectId }).userId);
      const subId = String((sub as { _id: Types.ObjectId })._id);
      try {
        // 1. Clear any expired grant from a prior cycle. Only the expiring grant
        //    bucket is swept; purchased balance is untouched.
        await this.wallet.expireGrants(userId);

        // 2. Grant the current cycle's included credits, keyed so a re-run in the
        //    same cycle is a no-op.
        const start = (sub as { currentPeriodStart?: Date }).currentPeriodStart;
        const end = (sub as { currentPeriodEnd?: Date }).currentPeriodEnd;
        if (!start || !end) {
          this.logger.warn(`Connect sub ${subId} missing billing period; skipping grant`);
          continue;
        }

        const credits =
          (sub as { appliedEntitlements?: { connect?: { includedBoostCredits?: number } } })
            .appliedEntitlements?.connect?.includedBoostCredits ?? 0;
        if (credits <= 0) continue;

        await this.wallet.grant(userId, credits, {
          idempotencyKey: `grant-${subId}-${new Date(start).getTime()}`,
          expiresAt: new Date(end),
        });
        granted += 1;
      } catch (e) {
        const err = e as { message?: string };
        this.logger.error(`Included-credit grant failed for sub=${subId}: ${err.message}`);
      }
    }

    this.logger.log(
      `Included-credit grant cron: ${granted}/${subs.length} subscription(s) granted`,
    );
  }
}
