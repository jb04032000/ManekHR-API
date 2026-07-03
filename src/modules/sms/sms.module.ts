import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SmsService } from './sms.service';
import { Msg91BalanceService } from './services/msg91-balance.service';
import { Msg91AdminController } from './msg91-admin.controller';
import { Msg91AdminService } from './services/msg91-admin.service';
import { Msg91PricingAdminService } from './services/msg91-pricing-admin.service';
import { Msg91PricingAdminController } from './msg91-pricing-admin.controller';
import { MarketingDispatchService } from './services/marketing-dispatch.service';
import { Msg91WidgetOtpService } from './services/msg91-widget-otp.service';
import { MarketingAdminController } from './marketing-admin.controller';
import {
  SmsDispatchLog,
  SmsDispatchLogSchema,
} from './schemas/sms-dispatch-log.schema';
import {
  Msg91CostTable,
  Msg91CostTableSchema,
} from './schemas/msg91-cost-table.schema';
import {
  Msg91WalletSnapshot,
  Msg91WalletSnapshotSchema,
} from './schemas/msg91-wallet-snapshot.schema';
import {
  Msg91TopUp,
  Msg91TopUpSchema,
} from './schemas/msg91-topup.schema';
import {
  OpsAlertState,
  OpsAlertStateSchema,
} from './schemas/ops-alert-state.schema';
import {
  PlatformCreditPool,
  PlatformCreditPoolSchema,
} from './schemas/platform-credit-pool.schema';
import {
  PlatformCreditLedger,
  PlatformCreditLedgerSchema,
} from './schemas/platform-credit-ledger.schema';
import {
  Subscription,
  SubscriptionSchema,
} from '../subscriptions/schemas/subscription.schema';
import {
  Workspace,
  WorkspaceSchema,
} from '../workspaces/schemas/workspace.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SmsDispatchLog.name, schema: SmsDispatchLogSchema },
      // Wave 4 credit-pack: SmsService deducts credits per send.
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      // Wave 8 — MSG91 cost-tracking + ops resilience.
      { name: Msg91CostTable.name, schema: Msg91CostTableSchema },
      { name: Msg91WalletSnapshot.name, schema: Msg91WalletSnapshotSchema },
      { name: Msg91TopUp.name, schema: Msg91TopUpSchema },
      // Wave 8.1 — throttled ops alert state.
      { name: OpsAlertState.name, schema: OpsAlertStateSchema },
      // Wave 8.2 — platform-side marketing credit pool + audit ledger.
      { name: PlatformCreditPool.name, schema: PlatformCreditPoolSchema },
      { name: PlatformCreditLedger.name, schema: PlatformCreditLedgerSchema },
    ]),
  ],
  controllers: [
    Msg91AdminController,
    Msg91PricingAdminController,
    MarketingAdminController,
  ],
  providers: [
    SmsService,
    Msg91BalanceService,
    Msg91AdminService,
    Msg91PricingAdminService,
    MarketingDispatchService,
    Msg91WidgetOtpService,
  ],
  exports: [
    SmsService,
    Msg91BalanceService,
    Msg91AdminService,
    Msg91PricingAdminService,
    MarketingDispatchService,
    Msg91WidgetOtpService,
  ],
})
export class SmsModule {}
