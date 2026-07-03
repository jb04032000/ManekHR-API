import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AddOnsService } from './add-ons.service';
import { AddOnsController } from './add-ons.controller';
import { CreditPackController } from './credit-pack.controller';
import { CreditPackCheckoutService } from './services/credit-pack-checkout.service';
import {
  AddOnDefinition,
  AddOnDefinitionSchema,
} from './schemas/add-on-definition.schema';
import {
  PurchasedAddOn,
  PurchasedAddOnSchema,
} from './schemas/purchased-add-on.schema';
import {
  CreditPackPayment,
  CreditPackPaymentSchema,
} from './schemas/credit-pack-payment.schema';
import {
  Subscription,
  SubscriptionSchema,
} from '../subscriptions/schemas/subscription.schema';
import { Plan, PlanSchema } from '../subscriptions/schemas/plan.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  Workspace,
  WorkspaceSchema,
} from '../workspaces/schemas/workspace.schema';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AddOnDefinition.name, schema: AddOnDefinitionSchema },
      { name: PurchasedAddOn.name, schema: PurchasedAddOnSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: Plan.name, schema: PlanSchema },
      // Wave 5 credit-pack low-balance alert: lookup owner email + workspaces.
      { name: User.name, schema: UserSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      // Wave 7 — credit-pack billing intents.
      { name: CreditPackPayment.name, schema: CreditPackPaymentSchema },
    ]),
    // Wave 5 credit-pack low-balance alert: dispatch email + in-app.
    MailModule,
    NotificationsModule,
    // Wave 7 — RazorpayPlatformService comes from BillingModule (@Global).
  ],
  controllers: [AddOnsController, CreditPackController],
  providers: [AddOnsService, CreditPackCheckoutService],
  exports: [AddOnsService, CreditPackCheckoutService],
})
export class AddOnsModule {}
