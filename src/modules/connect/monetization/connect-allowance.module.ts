import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Subscription, SubscriptionSchema } from '../../subscriptions/schemas/subscription.schema';
import { Plan, PlanSchema } from '../../subscriptions/schemas/plan.schema';
import { ConnectAllowanceService } from './connect-allowance.service';

/**
 * ManekHR Connect - allowance-only module (M2.3 extraction).
 *
 * Provides + exports `ConnectAllowanceService` (and the Subscription + Plan
 * models it reads) WITHOUT any dependency on AdsModule. Split out of
 * `ConnectMonetizationModule` so a consumer that only needs the allowance
 * reader - `ConnectProfileModule` (the verified badge) and `ConnectSearchModule`
 * (search ranking) - can import it without pulling in AdsModule. AdsModule
 * imports `ConnectProfileModule`, so a profile -> monetization -> ads -> profile
 * import cycle would otherwise form. This module breaks that cycle: it depends
 * only on the two billing models.
 *
 * `MongooseModule` is re-exported so `ConnectMonetizationModule` (which imports
 * this for the service) still resolves the Subscription model for its grant cron.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: Plan.name, schema: PlanSchema },
    ]),
  ],
  providers: [ConnectAllowanceService],
  exports: [ConnectAllowanceService, MongooseModule],
})
export class ConnectAllowanceModule {}
