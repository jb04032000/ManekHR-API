import { BadRequestException, Injectable } from '@nestjs/common';
import { Plan } from '../../schemas/plan.schema';
import { BillingCycle, PriceQuote } from '../billing.types';

interface ComputeQuoteOpts {
  /**
   * Reduces the plan's list price by this many paise BEFORE GST
   * re-computation. Used by the coupon engine for percentage and
   * fixed_amount discounts.
   */
  discountOnBasePaise?: number;
  /**
   * Overrides the final GST-inclusive total directly. GST is
   * reverse-computed from this value. Used by fixed_price coupons.
   * Mutually exclusive with `discountOnBasePaise`.
   */
  finalTotalOverridePaise?: number;
  /** Stamped onto the returned quote for downstream persistence. */
  appliedCouponCode?: string;
  appliedCouponId?: string;
}

/**
 * Computes a `PriceQuote` for `(plan, billingCycle)`. Single responsibility —
 * turns a plan + cycle into a snapshot of base / discount / GST / total in
 * paise. Coupon application happens in `CouponService` and is fed in via
 * `opts` — this service stays pure (no DB).
 *
 * GST handling:
 *   - `plan.isPriceTaxInclusive=false` (default): listed price is the
 *     taxable base; GST is added on top.
 *   - `plan.isPriceTaxInclusive=true`: listed price already includes GST;
 *     reverse-compute the taxable base.
 *   - When `opts.finalTotalOverridePaise` is set (fixed_price coupon),
 *     the override is treated as the final GST-inclusive total — GST is
 *     reverse-computed from it regardless of the plan's tax-inclusive
 *     flag, since the coupon is selling the user a specific final price.
 *
 * All math is integer-paise to avoid floating drift. Rounding: GST rounds
 * to the nearest paise; the total = base − discount + GST (or the
 * override when set).
 */
@Injectable()
export class PricingService {
  computeQuote(plan: Plan, billingCycle: BillingCycle, opts: ComputeQuoteOpts = {}): PriceQuote {
    if (billingCycle === 'lifetime') {
      throw new BadRequestException('Lifetime plans are not sold through self-serve checkout');
    }

    if (opts.discountOnBasePaise !== undefined && opts.finalTotalOverridePaise !== undefined) {
      throw new BadRequestException(
        'discountOnBasePaise and finalTotalOverridePaise are mutually exclusive',
      );
    }

    const listPriceRupees = billingCycle === 'monthly' ? plan.monthlyPrice : plan.yearlyPrice;

    if (typeof listPriceRupees !== 'number' || listPriceRupees < 0) {
      throw new BadRequestException(
        // String() around the ObjectId — lint restrict-template-expressions.
        `Plan ${String(plan._id)} has no valid price for ${billingCycle} cycle`,
      );
    }

    const listPricePaise = Math.round(listPriceRupees * 100);
    // Task 3 — optional/configurable subscription-plan GST. `gstEnabled` is
    // ON unless EXPLICITLY false (undefined = pre-field plan = ON, back-compat).
    // When disabled we force rate 0 so the discount-on-base / inclusive / and
    // fixed-price-override paths all naturally compute 0 GST, and the rate-0
    // quote propagates through ProrationService (roundGst(rate=0) ⇒ 0) and the
    // persisted SubscriptionPayment (gstPaise 0 / rate 0). NOT the Finance/ERP
    // invoicing GST — that module is separate.
    const gstEnabled = plan.gstEnabled !== false;
    const gstRatePercent = gstEnabled ? (plan.gstRatePercent ?? 18) : 0;

    let basePricePaise = listPricePaise;
    let discountPaise = 0;
    let taxableBasePaise: number;
    let gstPaise: number;
    let totalPaise: number;

    if (opts.finalTotalOverridePaise !== undefined) {
      // Fixed-price override — GST reverse-computed from the override. With GST
      // disabled (rate 0) the denominator is 1, so the whole override is the
      // taxable base and gstPaise is 0 — no reverse-carve.
      const overrideTotal = Math.max(0, Math.round(opts.finalTotalOverridePaise));
      const denominator = 1 + gstRatePercent / 100;
      taxableBasePaise = Math.round(overrideTotal / denominator);
      gstPaise = overrideTotal - taxableBasePaise;
      totalPaise = overrideTotal;
      discountPaise = Math.max(0, listPricePaise - overrideTotal);
      basePricePaise = listPricePaise;
    } else {
      // Discount-on-base path (no discount → discountOnBasePaise=0).
      const requestedDiscount = Math.max(0, Math.round(opts.discountOnBasePaise ?? 0));
      discountPaise = Math.min(requestedDiscount, listPricePaise);
      const discountedBasePaise = listPricePaise - discountPaise;

      if (gstEnabled && plan.isPriceTaxInclusive) {
        // Carve GST out of an inclusive price. Skipped entirely when GST is
        // disabled — the price is then taken as-is (no phantom carve).
        const denominator = 1 + gstRatePercent / 100;
        taxableBasePaise = Math.round(discountedBasePaise / denominator);
        gstPaise = discountedBasePaise - taxableBasePaise;
        totalPaise = discountedBasePaise;
      } else {
        // Exclusive add (rate 0 ⇒ gstPaise 0 ⇒ total == base when disabled).
        taxableBasePaise = discountedBasePaise;
        gstPaise = Math.round((discountedBasePaise * gstRatePercent) / 100);
        totalPaise = discountedBasePaise + gstPaise;
      }
    }

    return {
      planId: String(plan._id),
      billingCycle,
      basePricePaise,
      discountPaise,
      taxableBasePaise,
      gstPaise,
      gstRatePercent,
      gstEnabled,
      totalPaise,
      sacCode: plan.sacCode ?? '998314',
      isPriceTaxInclusive: plan.isPriceTaxInclusive ?? false,
      appliedCouponCode: opts.appliedCouponCode,
      appliedCouponId: opts.appliedCouponId,
    };
  }
}
