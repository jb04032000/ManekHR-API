import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectCreditDrop, ConnectCreditDropSchema } from './schemas/connect-credit-drop.schema';
import { ConnectPromotionService } from './services/connect-promotion.service';
import { ConnectPromotionAdminController } from './controllers/connect-promotion-admin.controller';
import { ConnectAllowanceModule } from '../monetization/connect-allowance.module';
import { AdsModule } from '../ads/ads.module';
import { AuditModule } from '../../audit/audit.module';

/**
 * ManekHR Connect -- Promotions / sales module (Phase M3.2).
 *
 * Hosts the admin credit-drop primitive (free boost-credit gifts to sellers).
 * Imports:
 *  - `ConnectAllowanceModule` for the Subscription model (cohort targeting by
 *    active Connect / bundle subscription), re-exported as MongooseModule there.
 *  - `AdsModule` for the shipped person-centric `WalletService.grant`.
 *  - `AuditModule` for the admin write audit.
 *  (`PostHogService` is `@Global`, so no import is needed.)
 *
 * Plan discounts / intro offers / scheduled sale windows reuse the existing
 * coupon engine and need nothing here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: ConnectCreditDrop.name, schema: ConnectCreditDropSchema }]),
    ConnectAllowanceModule,
    AdsModule,
    AuditModule,
  ],
  controllers: [ConnectPromotionAdminController],
  providers: [ConnectPromotionService],
  exports: [ConnectPromotionService],
})
export class ConnectPromotionsModule {}
