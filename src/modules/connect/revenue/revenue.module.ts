import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Plan, PlanSchema } from '../../subscriptions/schemas/plan.schema';
import {
  SubscriptionPayment,
  SubscriptionPaymentSchema,
} from '../../subscriptions/billing/schemas/subscription-payment.schema';
import { ConnectRevenueService } from './services/connect-revenue.service';
import { ConnectRevenueAdminController } from './controllers/connect-revenue-admin.controller';

/**
 * ManekHR Connect -- revenue dashboard module (Phase M3.3).
 *
 * Registers the SubscriptionPayment + Plan models locally so the revenue
 * service rolls up Connect subscription revenue without importing the
 * subscriptions service layer. Boost / ad spend is read by the web dashboard
 * from the existing ads revenue endpoint, so no AdsModule dependency here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SubscriptionPayment.name, schema: SubscriptionPaymentSchema },
      { name: Plan.name, schema: PlanSchema },
    ]),
  ],
  controllers: [ConnectRevenueAdminController],
  providers: [ConnectRevenueService],
  exports: [ConnectRevenueService],
})
export class ConnectRevenueModule {}
