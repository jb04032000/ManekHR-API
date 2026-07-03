import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { AppModule } from '../../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../../common/enums/feature-access.enum';
import { PlatformAccess } from '../../../common/enums/platform-access.enum';

// ── Localized text ────────────────────────────────────────────────────────────

/**
 * Per-locale display text. `en` is canonical + required; `gu-en` / `hi-en` /
 * `gu` are optional (UI falls back to `en`). Mirrors the leave-type labels
 * model.
 */
export interface LocalizedText {
  en: string;
  'gu-en'?: string | null;
  'hi-en'?: string | null;
  gu?: string | null;
}

@Schema({ _id: false })
export class LocalizedTextField {
  @Prop({ required: true }) en: string;
  @Prop({ type: String, default: null }) 'gu-en'?: string | null;
  @Prop({ type: String, default: null }) 'hi-en'?: string | null;
  @Prop({ type: String, default: null }) gu?: string | null;
}

// ── Plan badge ────────────────────────────────────────────────────────────────

const BADGE_TONES = ['brand', 'gold', 'success', 'info', 'neutral', 'danger'] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];

@Schema({ _id: false })
export class PlanBadge {
  @Prop({ type: LocalizedTextField, required: true }) label: LocalizedTextField;
  @Prop({ type: String, enum: BADGE_TONES, default: 'neutral' }) tone: BadgeTone;
}

// ── Plan marketing subdoc ─────────────────────────────────────────────────────

/**
 * Optional marketing display metadata for a plan. All fields are optional;
 * a plan with `marketing: {}` is valid and behaviour-neutral.
 */
@Schema({ _id: false })
export class PlanMarketing {
  /** Sort position on pricing page (lower = earlier). Unset = end of list. */
  @Prop({ type: Number }) displayOrder?: number;

  /** When true, the pricing card is visually highlighted (e.g. "Most popular"). */
  @Prop({ default: false }) isHighlighted?: boolean;

  /** Optional badge displayed on the pricing card (e.g. "Best Value"). */
  @Prop({ type: PlanBadge }) badge?: PlanBadge;

  /** Short marketing tagline shown below the plan name on the pricing page. */
  @Prop({ type: LocalizedTextField }) tagline?: LocalizedTextField;

  /**
   * Up to ~5 feature highlights shown as bullet points on the pricing card.
   * Ordered; first item is the most prominent.
   */
  @Prop({ type: [LocalizedTextField], default: [] }) featureHighlights?: LocalizedTextField[];

  /** Override label for the subscribe/upgrade CTA button. Null = default copy. */
  @Prop({ type: LocalizedTextField }) ctaLabel?: LocalizedTextField;

  /**
   * Crossed-out "was" price shown beside the actual monthlyPrice (rupees).
   * Used to communicate a discount without altering the real price.
   */
  @Prop({ type: Number }) compareAtMonthlyPrice?: number;

  /** Crossed-out "was" price shown beside the actual yearlyPrice (rupees). */
  @Prop({ type: Number }) compareAtYearlyPrice?: number;

  /**
   * Coupon code pre-filled at checkout for this plan's pricing card.
   * Useful for plan-specific launch promotions.
   */
  @Prop({ type: String }) featuredCouponCode?: string;
}

@Schema({ _id: false })
export class PlanFeatures {
  @Prop({ default: false }) export: boolean;
  @Prop({ default: false }) apiAccess: boolean;
  @Prop({ default: false }) advancedRbac: boolean;
  @Prop({ default: false }) customRoles: boolean;
  @Prop({ default: false }) shifts: boolean;
  @Prop({ default: false }) bills: boolean;
}

@Schema({ _id: false })
export class ModuleSubFeatureAccess {
  @Prop({ required: true }) key: string;
  @Prop({ type: String, enum: FeatureAccessLevel, required: true })
  access: FeatureAccessLevel;
}

@Schema({ _id: false })
export class ModuleAccessEntry {
  @Prop({ type: String, enum: AppModule, required: true }) module: AppModule;
  @Prop({ required: true, default: false }) enabled: boolean;
  @Prop({ type: [ModuleSubFeatureAccess], default: [] })
  subFeatures: ModuleSubFeatureAccess[];
}

/**
 * Wave-3 Drift #36 — Storage quota dimension on PlanEntitlements.
 * Per locked decision in MODULE_INVENTORY.md §3.5.3:
 *   Free 100MB / Starter 500MB / Growth 2GB / Business 10GB / Enterprise 50GB.
 * -1 = unlimited.
 */
@Schema({ _id: false })
export class PlanStorageEntitlements {
  /** Total storage cap in GB. -1 = unlimited. */
  @Prop({ default: 0.1 }) totalGbPerWorkspace: number;
  /** Per-file maximum upload size in MB. Override default UPLOAD_MAX_FILE_SIZE. */
  @Prop({ default: 1 }) perFileMaxMb: number;
}

/**
 * Credit-pack model — pre-paid SMS / WhatsApp message balances.
 *
 * SMS / WhatsApp messaging is NOT included in any tier (see locked decision
 * in MODULE_INVENTORY.md §3.5). Customers buy CREDIT_PACK add-ons to top up.
 * Balance fields persist across recomputes — `mergeEntitlements()` preserves
 * them from the prior `appliedEntitlements`. Mutated imperatively via
 * `applyCreditPackToBalance()` (top-up) and `consumeCredit()` (per-send).
 */
@Schema({ _id: false })
export class PlanCommunicationsEntitlements {
  /** Pre-paid SMS message balance. Decremented per send. */
  @Prop({ default: 0 }) smsCreditsBalance: number;
  /** Pre-paid WhatsApp message balance. Decremented per send. */
  @Prop({ default: 0 }) whatsappCreditsBalance: number;
  /** Auto-recharge enabled (Pro+). When balance < threshold, cron buys pack. */
  @Prop({ default: false }) autoRechargeEnabled: boolean;
  /** SMS auto-recharge low-balance trigger threshold. */
  @Prop({ default: 50 }) autoRechargeThresholdSms: number;
  /** WhatsApp auto-recharge low-balance trigger threshold. */
  @Prop({ default: 50 }) autoRechargeThresholdWhatsapp: number;
  /** AddOn slug to auto-purchase for SMS top-up (e.g. 'sms-pack-500'). */
  @Prop() autoRechargeSmsPackSlug?: string;
  /** AddOn slug to auto-purchase for WhatsApp top-up. */
  @Prop() autoRechargeWhatsappPackSlug?: string;
  /** Last low-balance alert sent at (used to throttle re-alert at next 10% drop). */
  @Prop() lastLowBalanceAlertAt?: Date;

  /**
   * Wave 8 — set true after the one-shot Free-tier trial credits (10 SMS,
   * 5 WhatsApp) have been granted on this subscription. Gates re-grant on
   * downgrade/upgrade flows. Per-subscription (1:1 with workspace owner).
   */
  @Prop({ default: false }) lifetimeTrialGranted: boolean;
}

/**
 * Connect (network / marketplace) allowances. Person-centric. Mirrors the
 * storage / communications sub-block pattern above. `-1` = unlimited where
 * noted. Granted into / enforced against the person's Connect subscription.
 */
@Schema({ _id: false })
export class PlanConnectEntitlements {
  /** Max active marketplace listings. -1 = unlimited. */
  @Prop({ default: 0 }) maxListings: number;
  /** Buyer inquiries / contact unlocks per cycle. -1 = unlimited. */
  @Prop({ default: 0 }) leadsPerMonth: number;
  /** Boost credits granted into the Connect wallet each cycle (expire on reset). */
  @Prop({ default: 0 }) includedBoostCredits: number;
  /** Eligible for the verified marker (further gated on real verification). */
  @Prop({ default: false }) verifiedBadge: boolean;
  /** Ranking weight in marketplace search. 0 = normal. */
  @Prop({ default: 0 }) searchPriority: number;
  /**
   * Per-USER storage cap (MB) for Connect media (categories prefixed
   * `connect-`). Person-centric, unlike the workspace `storage` block above.
   * Free-tier default 500 MB; `-1` = unlimited. Enforced by UploadsService
   * against the sum of the person's non-deleted Connect upload records.
   */
  @Prop({ default: 500 }) storageMb: number;

  /**
   * Max Company Pages a person may own. -1 = unlimited. Free default 1.
   * Mirrors CONNECT_FREE_DEFAULT_ALLOWANCES so a Connect/bundle PACKAGE can
   * express the "1 company" cap directly — previously this (and storefront /
   * job caps) was only settable via a per-user override, never via a plan.
   */
  @Prop({ default: 1 }) maxCompanyPages: number;
  /** Max Storefronts a person may own. -1 = unlimited. Free default 1. */
  @Prop({ default: 1 }) maxStorefronts: number;
  /** Max simultaneously-OPEN job posts. -1 = unlimited. Free default 10. */
  @Prop({ default: 10 }) maxJobs: number;

  /**
   * What happens to a person who is OVER a count limit (items predating a limit
   * drop, or after an admin lowers their override). Additive; default `freeze`
   * = today's behavior exactly (existing items stay live forever, creation stays
   * blocked, nothing else happens). `hide_newest` = after `overLimitGraceDays`,
   * the newest items beyond the limit are SUPPRESSED from public surfaces but
   * stay visible + editable to the owner (nothing is ever deleted). Suppression
   * is COMPUTED at read time by ConnectSuppressionService — never a stored flag —
   * so delete / re-upgrade reverse it instantly. See
   * docs/connect/2026-06-12-connect-over-limit-policy.md.
   */
  @Prop({ type: String, enum: ['freeze', 'hide_newest'], default: 'freeze' })
  overLimitPolicy: 'freeze' | 'hide_newest';

  /**
   * Grace period (days) after a person first goes over a limit before the
   * `hide_newest` policy suppresses anything. Fair-warning window; ignored under
   * `freeze`. Default 30. The clock (`overLimitSince`) resets if they return
   * under the limit.
   */
  @Prop({ default: 30 }) overLimitGraceDays: number;
}

@Schema({ _id: false })
export class PlanEntitlements {
  @Prop({ default: 1 }) maxWorkspaces: number;
  @Prop({ default: 5 }) maxMembersPerWorkspace: number;
  @Prop({ default: 5 }) maxTotalMembers: number;
  @Prop({ type: [String], enum: AppModule, default: [] }) modules: AppModule[];
  @Prop({ type: PlanFeatures, default: () => ({}) }) features: PlanFeatures;
  @Prop({ type: [ModuleAccessEntry], default: [] })
  moduleAccess: ModuleAccessEntry[];
  @Prop({ type: String, enum: PlatformAccess, default: PlatformAccess.BOTH })
  platformAccess: PlatformAccess;
  @Prop({ default: 3 }) maxSessionsPerPlatform: number;
  @Prop({ default: 5 }) maxSessionsTotal: number;
  @Prop({ default: 0 }) emailsPerMonth: number;
  /** Wave-3 Drift #36 — storage quota (Free 100MB → Enterprise 50GB). */
  @Prop({ type: PlanStorageEntitlements, default: () => ({}) })
  storage: PlanStorageEntitlements;
  /** Wave 4 — credit-pack balances + auto-recharge config. */
  @Prop({ type: PlanCommunicationsEntitlements, default: () => ({}) })
  communications: PlanCommunicationsEntitlements;
  /** Connect (network / marketplace) allowances. Person-centric. */
  @Prop({ type: PlanConnectEntitlements, default: () => ({}) })
  connect: PlanConnectEntitlements;
}

@Schema({ timestamps: true })
export class Plan extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  tier: string;

  /**
   * Which product line this plan sells:
   *   erp     = ERP workspace plan (default; existing behavior unchanged)
   *   connect = person-centric Connect plan (network / marketplace)
   *   bundle  = combined ERP + Connect
   */
  @Prop({ type: String, enum: ['erp', 'connect', 'bundle'], default: 'erp', index: true })
  product: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ required: true })
  monthlyPrice: number;

  @Prop({ required: true })
  yearlyPrice: number;

  @Prop({ type: PlanEntitlements, required: true })
  entitlements: PlanEntitlements;

  // ── Custom-plan extensions ────────────────────────────────────────────
  /**
   * `false` (default) → catalogue plan visible to every user in the public
   * pricing page. `true` → bespoke plan tied to a specific user or workspace
   * via `assignedUserId` / `assignedWorkspaceId`. Custom plans never appear
   * in `/subscriptions/plans` for unrelated users.
   */
  @Prop({ default: false })
  isCustom: boolean;

  /** When set + isCustom=true, only this user can subscribe to this plan. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  assignedUserId?: Types.ObjectId | null;

  /**
   * When set + isCustom=true, the plan is scoped to this specific workspace.
   * Used when an enterprise customer's deal is for a single workspace.
   */
  @Prop({ type: Types.ObjectId, ref: 'Workspace', default: null })
  assignedWorkspaceId?: Types.ObjectId | null;

  /**
   * Whether this plan is shown on the public pricing page. Catalogue plans
   * default to `true`; custom plans default to `false`.
   */
  @Prop({ default: true })
  isPubliclyVisible: boolean;

  /**
   * Exactly one plan per product is the default new sign-ups are auto-assigned
   * (Phase 2). Enforced single-default in the admin create/update service.
   */
  @Prop({ default: false })
  isDefault: boolean;

  /**
   * Marks this plan as the admin-configurable TRIAL plan for its product.
   * Exactly one trial plan per product (enforced single-trial in the admin
   * create/update service, mirroring isDefault). Its `entitlements` define what
   * a signup's trial unlocks (replacing the old hardcoded full-access fallback)
   * and its `trialDurationDays` is the trial length. New signups START on it;
   * on expiry they DOWNGRADE to the default plan (purchasedEntitlements = the
   * default plan's entitlements). A trial plan is a system plan, not buyable, so
   * the admin service forces isPubliclyVisible:false when this is set.
   */
  @Prop({ default: false })
  isTrialPlan: boolean;

  // ── Trial config (per-plan) ───────────────────────────────────────────
  /** Days of free trial before the first charge. 0 = no trial. */
  @Prop({ default: 0 })
  trialDurationDays: number;

  /**
   * If `true`, the user must save a payment method before the trial begins
   * (Razorpay mandate). Auto-debits at end of trial. Admin-configurable per
   * plan in the admin panel.
   */
  @Prop({ default: false })
  trialCardRequired: boolean;

  // ── Upfront-vs-installments term billing ──────────────────────────────
  /**
   * Discount applied to the yearly price for a single upfront payment;
   * installments pay the full yearly price at 0% interest. Admin-tunable per
   * plan. 0 = no discount.
   */
  @Prop({ type: Number, default: 0 })
  upfrontDiscountPercent: number;

  /** Whether the 'pay monthly in installments' option is offered for this plan. */
  @Prop({ type: Boolean, default: true })
  installmentsEnabled: boolean;

  /** Number of monthly installments the yearly price is split into (default 12). */
  @Prop({ type: Number, default: 12 })
  installmentMonths: number;

  // ── Pricing flags ─────────────────────────────────────────────────────
  /**
   * Whether GST applies to this plan at all (Task 3 — optional/configurable
   * subscription-plan GST). Default `true` preserves today's always-on GST;
   * `false` drops GST entirely for this plan (PricingService forces rate 0 +
   * gstPaise 0, and the rate-0 quote propagates through proration + the
   * invoice PDF, which then suppresses the tax rows). NOTE: this is the
   * subscription-plan GST only — unrelated to the Finance/ERP invoicing GST
   * module. Plans predating this field read `undefined`, treated as ON.
   */
  @Prop({ default: true })
  gstEnabled: boolean;

  /**
   * Whether `monthlyPrice` / `yearlyPrice` already include GST. When `false`
   * (default), GST is computed and added on top at checkout.
   */
  @Prop({ default: false })
  isPriceTaxInclusive: boolean;

  /** GST rate in percentage (e.g. 18 for 18%). Default 18. */
  @Prop({ default: 18 })
  gstRatePercent: number;

  /**
   * SAC (Service Accounting Code) for this plan. Required on GST invoice.
   * Default 998314 = Information technology consulting and support services.
   */
  @Prop({ default: '998314' })
  sacCode: string;

  // ── Recurring billing toggle ──────────────────────────────────────────
  /**
   * Whether this plan is sold via Razorpay Subscriptions API (auto-renew
   * mandate) or as a one-time charge per period. Both paths can coexist on
   * the same plan if both flags are true — the user picks at checkout.
   */
  @Prop({ default: true })
  supportsAutoRenew: boolean;

  @Prop({ default: true })
  supportsOneTime: boolean;

  // ── Razorpay-side mirror (D1c) ────────────────────────────────────────
  /**
   * Razorpay Plan id mirroring this local plan's MONTHLY price + GST.
   * Lazy-populated on first mandate use (`SubscriptionMandateService.
   * ensureRazorpayPlan`). Sparse — set only after the first monthly
   * mandate has been created. Race-safe via atomic `findOneAndUpdate`
   * with `$exists:false` guard; orphan plans on Razorpay side accepted
   * (they are free).
   */
  @Prop({ type: String, sparse: true })
  razorpayPlanIdMonthly?: string;

  /** Razorpay Plan id for YEARLY price + GST. Same lifecycle as above. */
  @Prop({ type: String, sparse: true })
  razorpayPlanIdYearly?: string;

  /**
   * Razorpay subscriptions require a fixed `total_count` (number of
   * billing cycles) — the mandate auto-completes after N cycles and
   * silently stops billing. Defaults below are effectively-forever:
   *   - monthly: 120 cycles = 10 years
   *   - yearly:   50 cycles = 50 years
   * Admins can override per-plan when a fixed-term contract exists
   * (e.g. annual prepay with 1-cycle yearly mandate).
   */
  @Prop({ type: Number })
  recurringTotalCountMonthly?: number;

  @Prop({ type: Number })
  recurringTotalCountYearly?: number;

  // ── Marketing display metadata ────────────────────────────────────────────
  /**
   * Optional marketing display configuration. All sub-fields are optional;
   * existing plans with no marketing config default to `{}` with no
   * behavioral change.
   */
  @Prop({ type: PlanMarketing, default: () => ({}) })
  marketing: PlanMarketing;
}

export const PlanSchema = SchemaFactory.createForClass(Plan);
