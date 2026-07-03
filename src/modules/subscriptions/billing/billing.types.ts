/**
 * Shared billing types — used across services + controllers in the billing
 * subdomain. Keep this file dependency-free (no module imports) so it can
 * be shared with DTOs without circular import worries.
 */

export type BillingCycle = 'monthly' | 'yearly' | 'lifetime';
export type PaymentMode = 'one_time' | 'recurring';
export type Gateway = 'razorpay' | 'manual';

export type PaymentStatus =
  | 'created'
  | 'authorised'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'cancelled';

export type CouponDiscountType = 'percentage' | 'fixed_amount' | 'fixed_price';

export type SubscriptionSource =
  | 'self'
  | 'admin'
  | 'manual_payment'
  | 'paid_link'
  | 'trial'
  | 'migrated';

/**
 * Snapshot of a checkout-time price calculation. Built by the pricing
 * service; consumed by the order-create + invoice-generate paths.
 */
export interface PriceQuote {
  planId: string;
  billingCycle: BillingCycle;
  /** Plan list price for the chosen cycle. */
  basePricePaise: number;
  /** Coupon discount, if any. */
  discountPaise: number;
  /** Taxable base = base − discount. */
  taxableBasePaise: number;
  /** GST in paise (taxableBase * gstRate%). */
  gstPaise: number;
  /** GST rate snapshot (0 when the plan has GST disabled). */
  gstRatePercent: number;
  /** Whether GST applied to this quote (Task 3 — plan.gstEnabled). False ⇒ no GST. */
  gstEnabled: boolean;
  /** What the customer is charged. */
  totalPaise: number;
  /** SAC code snapshot. */
  sacCode: string;
  /** Whether the plan price was already tax-inclusive. */
  isPriceTaxInclusive: boolean;
  /** Coupon code at quote time. Undefined when no coupon applied. */
  appliedCouponCode?: string;
  appliedCouponId?: string;
}

/**
 * Snapshot of a plan-change (upgrade / downgrade / lateral) price
 * calculation. Built by `ProrationService.computePlanChangeQuote`;
 * consumed by the plan-change order-create path and surfaced to the
 * customer as the upgrade/downgrade preview.
 *
 * All monetary fields are integer paise. `unusedCreditPaise` and
 * `targetChargePaise` are on a TAXABLE basis (pre-GST); `gstPaise` is
 * the GST on `netTaxablePaise`; `netPayablePaise` is the GST-inclusive
 * amount the customer pays now (0 for a deferred / lateral change).
 */
export interface PlanChangeQuote {
  /** Direction of the change, derived from yearly-equivalent plan rank. */
  direction: 'upgrade' | 'downgrade' | 'lateral';
  currentPlanId: string;
  currentPlanName: string;
  targetPlanId: string;
  targetPlanName: string;
  currentBillingCycle: BillingCycle;
  targetBillingCycle: BillingCycle;
  /** Length of the current billing period, in days (>= 1). */
  totalDays: number;
  /** Unused days left in the current period (0..totalDays). */
  remainingDays: number;
  /** Taxable-basis credit for unused current-plan time. */
  unusedCreditPaise: number;
  /** Taxable-basis charge for the target plan (prorated span or full cycle). */
  targetChargePaise: number;
  /** max(0, targetChargePaise - unusedCreditPaise). */
  netTaxablePaise: number;
  /** GST on `netTaxablePaise`. */
  gstPaise: number;
  /** GST rate snapshot (the target plan's rate). */
  gstRatePercent: number;
  /** netTaxablePaise + gstPaise — what the customer pays NOW (0 for deferred downgrade). */
  netPayablePaise: number;
  /** When the price is collected / change is applied. */
  appliesAt: 'immediate' | 'cycle_end';
  /** ISO — when the plan change takes effect. */
  effectiveDate: string;
  /** ISO — next renewal / period-end after the change. */
  renewalDate: string;
  /** Policy snapshot at quote time ('prorated' | 'full_reset'). */
  upgradeMode: string;
  /** Coupon code stamped onto the quote, when one was applied. */
  appliedCouponCode?: string;
}

/**
 * Per-coupon snapshot from coupon resolution. Used by the checkout +
 * mandate paths to persist on `SubscriptionPayment` and to record into
 * the `CouponRedemption` collection at capture time.
 */
export interface ResolvedCoupon {
  couponId: string;
  code: string;
  discountType: 'percentage' | 'fixed_amount' | 'fixed_price';
  /** The portion of the total discount attributable to this coupon (paise). */
  discountAppliedPaise: number;
}

/**
 * Output of `CouponService.resolveCodes` / `resolveAutoApply`.
 *
 * Two coupon application modes:
 *   1. `discountOnBasePaise` — reduces the plan's list price (percentage
 *      and fixed_amount coupons). GST is then re-computed on the
 *      reduced base per the plan's tax-inclusive flag.
 *   2. `finalTotalOverridePaise` — sets the final GST-inclusive total
 *      directly (fixed_price coupon). GST is reverse-computed from
 *      this total. Mutually exclusive with discountOnBasePaise — a
 *      fixed_price coupon is non-stackable by construction.
 */
export interface DiscountResolution {
  resolved: ResolvedCoupon[];
  /** Set when at least one percentage / fixed_amount coupon resolved. */
  discountOnBasePaise?: number;
  /** Set when a fixed_price coupon resolved (mutually exclusive with discountOnBasePaise). */
  finalTotalOverridePaise?: number;
  /** Total discount in paise — what the user "saved". For display + stamping. */
  totalDiscountPaise: number;
  /** Non-fatal advisories to surface to the client (e.g. cap notices). */
  warnings: string[];
}
