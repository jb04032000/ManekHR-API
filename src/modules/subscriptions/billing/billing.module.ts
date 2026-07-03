import { Global, Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import {
  SubscriptionPayment,
  SubscriptionPaymentSchema,
} from './schemas/subscription-payment.schema';
import {
  RazorpayWebhookEvent,
  RazorpayWebhookEventSchema,
} from './schemas/razorpay-webhook-event.schema';
import { Coupon, CouponSchema } from './schemas/coupon.schema';
import { CouponRedemption, CouponRedemptionSchema } from './schemas/coupon-redemption.schema';
import { BillingPolicy, BillingPolicySchema } from './schemas/billing-policy.schema';
import { RefundPolicy, RefundPolicySchema } from './schemas/refund-policy.schema';
import { RefundRequest, RefundRequestSchema } from './schemas/refund-request.schema';
import { BillingAuditEvent, BillingAuditEventSchema } from './schemas/billing-audit-event.schema';
import { InvoiceSequence, InvoiceSequenceSchema } from './schemas/invoice-sequence.schema';
import {
  MarketingCampaignDispatch,
  MarketingCampaignDispatchSchema,
} from './schemas/marketing-campaign-dispatch.schema';
import { Plan, PlanSchema } from '../schemas/plan.schema';
import { Subscription, SubscriptionSchema } from '../schemas/subscription.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { SubscriptionsModule } from '../subscriptions.module';
import { AddOnsModule } from '../../add-ons/add-ons.module';
import { MailModule } from '../../mail/mail.module';
import { RazorpayPlatformService } from './services/razorpay-platform.service';
import { PricingService } from './services/pricing.service';
import { ProrationService } from './services/proration.service';
import { SubscriptionCheckoutService } from './services/subscription-checkout.service';
import { PlanChangeService } from './services/plan-change.service';
import { SubscriptionMandateService } from './services/subscription-mandate.service';
import { RazorpayWebhookService } from './services/razorpay-webhook.service';
import { CouponService } from './services/coupon.service';
import { InvoiceNumberService } from './services/invoice-number.service';
import { InvoicePdfService } from './services/invoice-pdf.service';
import { InvoiceStorageService } from './services/invoice-storage.service';
import { InvoiceService } from './services/invoice.service';
import { BillingPolicyService } from './services/billing-policy.service';
import { DUNNING_QUEUE, DunningService } from './services/dunning.service';
import { DunningProcessor } from './services/dunning.processor';
import { RefundPolicyService } from './services/refund-policy.service';
import { RefundService } from './services/refund.service';
import { AdminBillingService } from './services/admin-billing.service';
import { AdminPaymentLinkService } from './services/admin-payment-link.service';
import { AdminPlanService } from './services/admin-plan.service';
import { AuditLogService } from './services/audit-log.service';
import { PaymentsQueryService } from './services/payments-query.service';
import { MarketingService } from './services/marketing.service';
import { TrialReminderCron } from './crons/trial-reminder.cron';
import { RenewalNoticeCron } from './crons/renewal-notice.cron';
import { WinBackCron } from './crons/win-back.cron';
import { AbandonedCheckoutCron } from './crons/abandoned-checkout.cron';
import { BillingCheckoutController } from './billing-checkout.controller';
import { PlanChangeController } from './plan-change.controller';
import { PaymentsController } from './payments.controller';
import { RazorpayPlatformWebhookController } from './razorpay-webhook.controller';
import { BillingMandateController } from './billing-mandate.controller';
import { BillingMandateAdminController } from './billing-mandate-admin.controller';
import { CouponAdminController } from './coupon-admin.controller';
import { CouponController } from './coupon.controller';
import { BillingProfileController } from './billing-profile.controller';
import { InvoiceController, InvoiceAdminController } from './invoice.controller';
import { DunningController } from './dunning.controller';
import { BillingPolicyAdminController } from './billing-policy-admin.controller';
import { RefundController } from './refund.controller';
import { RefundAdminController } from './refund-admin.controller';
import { AdminBillingController } from './admin-billing.controller';
import { AdminPlanController } from './admin-plan.controller';
import { AuditAdminController } from './audit-admin.controller';

/**
 * Subscription-billing module.
 *
 * D1a: schemas only.
 * D1b (current): one-time checkout — `RazorpayPlatformService`,
 * `PricingService`, `SubscriptionCheckoutService` + the `subscriptions/
 * checkout` controller.
 * D1c onwards: recurring billing, webhooks, coupons, refunds, admin
 * endpoints.
 *
 * Plan + Subscription models are registered locally via `forFeature` (in
 * addition to SubscriptionsModule's registration) so the checkout service
 * can inject them without depending on the import order resolving Mongoose
 * providers from SubscriptionsModule under `forwardRef`. `forFeature` is
 * idempotent — the underlying connection is the same Mongo client.
 *
 * D1g — `@Global()` so `BillingPolicyService` flows to every module.
 * Required because `SubscriptionGuard` (used via `@UseGuards(class)` in
 * many modules) is instantiated PER REQUESTING MODULE by Nest, and
 * each per-module instance needs its DI deps resolvable in that
 * module's scope. Without @Global, only modules that explicitly
 * import BillingModule could use `@UseGuards(SubscriptionGuard)`.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: SubscriptionPayment.name, schema: SubscriptionPaymentSchema },
      { name: RazorpayWebhookEvent.name, schema: RazorpayWebhookEventSchema },
      { name: Coupon.name, schema: CouponSchema },
      { name: CouponRedemption.name, schema: CouponRedemptionSchema },
      { name: BillingPolicy.name, schema: BillingPolicySchema },
      { name: RefundPolicy.name, schema: RefundPolicySchema },
      { name: RefundRequest.name, schema: RefundRequestSchema },
      // D1k — append-only billing audit log.
      { name: BillingAuditEvent.name, schema: BillingAuditEventSchema },
      { name: Plan.name, schema: PlanSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
      // D1c — User registered locally (idempotent forFeature) so the
      // mandate service can read/write `razorpayCustomerId` without
      // pulling in UsersModule (cycle: UsersModule -> ... -> BillingModule).
      { name: User.name, schema: UserSchema },
      // D1f — atomic GST invoice number sequence (per fiscal year).
      { name: InvoiceSequence.name, schema: InvoiceSequenceSchema },
      // D4 — idempotent marketing-campaign dispatch ledger.
      { name: MarketingCampaignDispatch.name, schema: MarketingCampaignDispatchSchema },
    ]),
    forwardRef(() => SubscriptionsModule),
    // Task 4 — plan-change apply re-derives entitlements through
    // AddOnsService.recalculateAppliedEntitlements. forwardRef because
    // AddOnsModule already participates in the Subscriptions↔AddOns↔Billing
    // cycle.
    forwardRef(() => AddOnsModule),
    // D1f — invoice email delivery via existing MailService.sendInvoiceEmail.
    MailModule,
    // D1g — BullMQ queue for delayed dunning jobs (grace reminder + grace expiry).
    BullModule.registerQueue({ name: DUNNING_QUEUE }),
  ],
  providers: [
    RazorpayPlatformService,
    PricingService,
    ProrationService,
    SubscriptionCheckoutService,
    PlanChangeService,
    SubscriptionMandateService,
    RazorpayWebhookService,
    CouponService,
    InvoiceNumberService,
    InvoicePdfService,
    InvoiceStorageService,
    InvoiceService,
    BillingPolicyService,
    DunningService,
    DunningProcessor,
    RefundPolicyService,
    RefundService,
    AdminBillingService,
    AdminPaymentLinkService,
    AdminPlanService,
    AuditLogService,
    PaymentsQueryService,
    // D4
    MarketingService,
    TrialReminderCron,
    RenewalNoticeCron,
    WinBackCron,
    AbandonedCheckoutCron,
  ],
  controllers: [
    BillingCheckoutController,
    PlanChangeController,
    PaymentsController,
    RazorpayPlatformWebhookController,
    BillingMandateController,
    BillingMandateAdminController,
    CouponAdminController,
    CouponController,
    BillingProfileController,
    InvoiceController,
    InvoiceAdminController,
    DunningController,
    BillingPolicyAdminController,
    RefundController,
    RefundAdminController,
    AdminBillingController,
    AdminPlanController,
    AuditAdminController,
  ],
  exports: [
    MongooseModule,
    SubscriptionCheckoutService,
    PlanChangeService,
    SubscriptionMandateService,
    PricingService,
    ProrationService,
    RazorpayPlatformService,
    RazorpayWebhookService,
    CouponService,
    InvoiceService,
    BillingPolicyService,
    DunningService,
    RefundPolicyService,
    RefundService,
    AdminBillingService,
    AdminPaymentLinkService,
    AdminPlanService,
    AuditLogService,
    PaymentsQueryService,
    MarketingService,
  ],
})
export class BillingModule {}
