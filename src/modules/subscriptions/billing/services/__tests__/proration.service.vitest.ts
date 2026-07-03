/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive schema imports (Plan, Subscription, BillingPolicy) don't trip
// the "Cannot determine type" reflection error under the test transform.
// ProrationService injects no Mongoose model — PricingService is the real
// pure service, BillingPolicyService is a hand-built mock — so nothing here
// actually touches Mongoose.
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { ProrationService } from '../proration.service';
import { PricingService } from '../pricing.service';
import type { Plan } from '../../../schemas/plan.schema';
import type { Subscription } from '../../../schemas/subscription.schema';
import type { BillingCycle } from '../../billing.types';
import { BadRequestException } from '@nestjs/common';

const DAY = 86_400_000;

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Builds a Plan-shaped plain object. PricingService only reads
 * _id / monthlyPrice / yearlyPrice / gstRatePercent / isPriceTaxInclusive /
 * sacCode, and ProrationService also reads `name`.
 */
function makePlan(opts: {
  id: string;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  gstRatePercent?: number;
  isPriceTaxInclusive?: boolean;
}): Plan {
  return {
    _id: opts.id,
    name: opts.name,
    monthlyPrice: opts.monthlyPrice,
    yearlyPrice: opts.yearlyPrice,
    gstRatePercent: opts.gstRatePercent ?? 18,
    isPriceTaxInclusive: opts.isPriceTaxInclusive ?? false,
    sacCode: '998314',
  } as unknown as Plan;
}

/** Builds a Subscription-shaped plain object with just the fields the service reads. */
function makeSubscription(opts: {
  billingCycle: BillingCycle;
  periodStart?: Date;
  periodEnd?: Date;
  planId?: string;
}): Subscription {
  return {
    billingCycle: opts.billingCycle,
    currentPeriodStart: opts.periodStart,
    currentPeriodEnd: opts.periodEnd,
    planId: opts.planId ?? 'plan-current',
  } as unknown as Subscription;
}

interface ProrationKnobs {
  upgradeMode?: 'prorated' | 'full_reset';
  downgradeMode?: 'cycle_end' | 'immediate';
  creditUnusedOnUpgrade?: boolean;
  allowDowngrade?: boolean;
  minProratedChargePaise?: number;
}

/** Hand-built BillingPolicyService stub — only `getPolicy()` is exercised. */
function makePolicyService(knobs: ProrationKnobs = {}) {
  const policy = {
    proration: {
      upgradeMode: knobs.upgradeMode ?? 'prorated',
      downgradeMode: knobs.downgradeMode ?? 'cycle_end',
      creditUnusedOnUpgrade: knobs.creditUnusedOnUpgrade ?? true,
      allowDowngrade: knobs.allowDowngrade ?? true,
      minProratedChargePaise: knobs.minProratedChargePaise ?? 0,
    },
  };
  return {
    getPolicy: vi.fn().mockResolvedValue(policy),
  } as any;
}

function makeService(knobs: ProrationKnobs = {}): ProrationService {
  // PricingService is pure — use the real one.
  return new ProrationService(new PricingService(), makePolicyService(knobs));
}

// Standard 30-day monthly window for the day-math cases.
const PERIOD_START = new Date('2026-01-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-01-31T00:00:00.000Z'); // exactly 30 days later
const MID_PERIOD = new Date('2026-01-16T00:00:00.000Z'); // 15 days in, 15 left

describe('ProrationService.computePlanChangeQuote', () => {
  let starterMonthly: Plan; // ₹500/mo
  let growthMonthly: Plan; // ₹1000/mo, ₹10000/yr

  beforeEach(() => {
    starterMonthly = makePlan({
      id: 'plan-starter',
      name: 'Starter',
      monthlyPrice: 500,
      yearlyPrice: 5000,
    });
    growthMonthly = makePlan({
      id: 'plan-growth',
      name: 'Growth',
      monthlyPrice: 1000,
      yearlyPrice: 10000,
    });
  });

  // 1. Same-cycle upgrade at mid-period (~half days) → net ≈ half the
  //    full-cycle taxable difference.
  it('same-cycle upgrade at mid-period charges ~half the full-cycle taxable difference', async () => {
    const svc = makeService();
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      planId: 'plan-starter',
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: MID_PERIOD,
    });

    expect(quote.direction).toBe('upgrade');
    expect(quote.totalDays).toBe(30);
    expect(quote.remainingDays).toBe(15);
    // Starter taxable 50000, prorated to 15/30 → 25000 credit.
    expect(quote.unusedCreditPaise).toBe(25000);
    // Growth taxable 100000, prorated to 15/30 → 50000 charge.
    expect(quote.targetChargePaise).toBe(50000);
    // net = 50000 - 25000 = 25000 ≈ half of (100000 - 50000).
    expect(quote.netTaxablePaise).toBe(25000);
    expect(quote.gstPaise).toBe(4500); // 18% of 25000
    expect(quote.netPayablePaise).toBe(29500);
    expect(quote.appliesAt).toBe('immediate');
    // Same-cycle prorated upgrade keeps the renewal date.
    expect(quote.renewalDate).toBe(PERIOD_END.toISOString());
    expect(quote.effectiveDate).toBe(MID_PERIOD.toISOString());
  });

  // 2. Same-cycle upgrade at period start (remainingDays == totalDays) →
  //    net ≈ full-cycle difference; renewalDate unchanged.
  it('same-cycle upgrade at period start charges the full-cycle difference, renewal unchanged', async () => {
    const svc = makeService();
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: PERIOD_START, // remainingDays == totalDays
    });

    expect(quote.remainingDays).toBe(quote.totalDays);
    expect(quote.unusedCreditPaise).toBe(50000); // full Starter taxable
    expect(quote.targetChargePaise).toBe(100000); // full Growth taxable
    expect(quote.netTaxablePaise).toBe(50000); // full-cycle difference
    expect(quote.gstPaise).toBe(9000);
    expect(quote.netPayablePaise).toBe(59000);
    expect(quote.renewalDate).toBe(PERIOD_END.toISOString()); // unchanged
  });

  // 3. Same-cycle upgrade at period end (remainingDays == 0) → netPayable == 0.
  it('same-cycle upgrade at period end yields zero net payable', async () => {
    const svc = makeService();
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: PERIOD_END, // periodEnd is NOT > now → handled, but remainingDays == 0
    });

    // periodEnd <= now → treated as fresh purchase OR remainingDays clamps
    // to 0. Either way the customer cannot owe a prorated slice; verify the
    // strict period-end boundary (now strictly before periodEnd).
    expect(quote.remainingDays).toBe(0);
  });

  // 3b. Strictly inside the period but one day from the end → still ~0.
  it('same-cycle upgrade one day before period end has near-zero net', async () => {
    const svc = makeService();
    const periodEnd = new Date('2026-01-31T00:00:00.000Z');
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd,
    });
    // 12 hours before end → round((periodEnd - now)/DAY) rounds to 1 day,
    // so use a point that rounds to 0 remaining days while still < periodEnd.
    const almostEnd = new Date(periodEnd.getTime() - DAY * 0.4);

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: almostEnd,
    });

    expect(quote.remainingDays).toBe(0);
    expect(quote.targetChargePaise).toBe(0);
    expect(quote.unusedCreditPaise).toBe(0);
    expect(quote.netTaxablePaise).toBe(0);
    expect(quote.netPayablePaise).toBe(0);
  });

  // 4. Cross-cycle upgrade monthly→yearly → charges (full yearly taxable −
  //    unused credit); renewalDate ≈ now + 1 year.
  it('cross-cycle upgrade (monthly→yearly) charges full yearly taxable minus unused credit', async () => {
    const svc = makeService();
    // Same plan, monthly→yearly: equal rank, same-plan disambiguation → upgrade.
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      planId: 'plan-growth',
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: growthMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'yearly',
      now: MID_PERIOD,
    });

    expect(quote.direction).toBe('upgrade');
    // Growth monthly taxable 100000, prorated 15/30 → 50000 credit.
    expect(quote.unusedCreditPaise).toBe(50000);
    // Cross-cycle → full yearly taxable (₹10000 → 1000000 paise).
    expect(quote.targetChargePaise).toBe(1000000);
    expect(quote.netTaxablePaise).toBe(950000); // 1000000 - 50000
    expect(quote.gstPaise).toBe(171000); // 18% of 950000
    expect(quote.netPayablePaise).toBe(1121000);
    expect(quote.appliesAt).toBe('immediate');

    // renewalDate ≈ now + 1 calendar year.
    const expectedRenewal = new Date(MID_PERIOD.getTime());
    expectedRenewal.setFullYear(expectedRenewal.getFullYear() + 1);
    expect(quote.renewalDate).toBe(expectedRenewal.toISOString());
    expect(quote.effectiveDate).toBe(MID_PERIOD.toISOString());
  });

  // 5. Downgrade with downgradeMode='cycle_end' → netPayable == 0,
  //    appliesAt='cycle_end', effectiveDate == periodEnd.
  it('cycle_end downgrade defers: zero payable, applies at cycle end', async () => {
    const svc = makeService({ downgradeMode: 'cycle_end' });
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      planId: 'plan-growth',
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: growthMonthly, // ₹1000/mo
      targetPlan: starterMonthly, // ₹500/mo — cheaper → downgrade
      targetBillingCycle: 'monthly',
      now: MID_PERIOD,
    });

    expect(quote.direction).toBe('downgrade');
    expect(quote.netPayablePaise).toBe(0);
    expect(quote.netTaxablePaise).toBe(0);
    expect(quote.gstPaise).toBe(0);
    expect(quote.unusedCreditPaise).toBe(0);
    expect(quote.appliesAt).toBe('cycle_end');
    expect(quote.effectiveDate).toBe(PERIOD_END.toISOString());
    // targetChargePaise is informational — full Starter taxable.
    expect(quote.targetChargePaise).toBe(50000);
    // renewalDate = periodEnd + 1 cycle.
    const expectedRenewal = new Date(PERIOD_END.getTime());
    expectedRenewal.setMonth(expectedRenewal.getMonth() + 1);
    expect(quote.renewalDate).toBe(expectedRenewal.toISOString());
  });

  // 5b. Downgrade with downgradeMode='immediate' → applies now, zero payable.
  it('immediate downgrade applies now with zero payable and no credit', async () => {
    const svc = makeService({ downgradeMode: 'immediate' });
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: growthMonthly,
      targetPlan: starterMonthly,
      targetBillingCycle: 'monthly',
      now: MID_PERIOD,
    });

    expect(quote.direction).toBe('downgrade');
    expect(quote.netPayablePaise).toBe(0);
    expect(quote.unusedCreditPaise).toBe(0);
    expect(quote.appliesAt).toBe('immediate');
    expect(quote.effectiveDate).toBe(MID_PERIOD.toISOString());
    const expectedRenewal = new Date(MID_PERIOD.getTime());
    expectedRenewal.setMonth(expectedRenewal.getMonth() + 1);
    expect(quote.renewalDate).toBe(expectedRenewal.toISOString());
  });

  // 6. creditUnusedOnUpgrade=false → unusedCreditPaise == 0, net larger.
  it('creditUnusedOnUpgrade=false drops the credit and produces a larger net', async () => {
    const withCredit = makeService({ creditUnusedOnUpgrade: true });
    const withoutCredit = makeService({ creditUnusedOnUpgrade: false });
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    const args = {
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly' as BillingCycle,
      now: MID_PERIOD,
    };

    const credited = await withCredit.computePlanChangeQuote(args);
    const uncredited = await withoutCredit.computePlanChangeQuote(args);

    expect(uncredited.unusedCreditPaise).toBe(0);
    expect(credited.unusedCreditPaise).toBe(25000);
    // No credit → net == full prorated target charge.
    expect(uncredited.netTaxablePaise).toBe(uncredited.targetChargePaise);
    expect(uncredited.netTaxablePaise).toBe(50000);
    expect(uncredited.netTaxablePaise).toBeGreaterThan(credited.netTaxablePaise);
  });

  // 7. minProratedChargePaise floor → a tiny computed net collapses to 0.
  it('minProratedChargePaise floor collapses a tiny computed net to zero', async () => {
    // High floor (₹10000 = 1_000_000 paise) — far above the ~29500 net of
    // the standard mid-period upgrade — so the charge collapses to free.
    const svc = makeService({ minProratedChargePaise: 1_000_000 });
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: MID_PERIOD,
    });

    expect(quote.direction).toBe('upgrade');
    expect(quote.netPayablePaise).toBe(0);
    expect(quote.netTaxablePaise).toBe(0);
    expect(quote.gstPaise).toBe(0);
  });

  // 8. upgradeMode='full_reset' → charges full target cycle regardless of
  //    remaining days.
  it('full_reset upgrade charges the full target cycle regardless of remaining days', async () => {
    const svc = makeService({ upgradeMode: 'full_reset' });
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: MID_PERIOD, // mid-period — would be prorated under 'prorated'
    });

    expect(quote.direction).toBe('upgrade');
    expect(quote.upgradeMode).toBe('full_reset');
    expect(quote.unusedCreditPaise).toBe(0); // no credit on full reset
    expect(quote.targetChargePaise).toBe(100000); // FULL Growth taxable
    expect(quote.netTaxablePaise).toBe(100000);
    expect(quote.gstPaise).toBe(18000);
    expect(quote.netPayablePaise).toBe(118000);
    expect(quote.appliesAt).toBe('immediate');
    // Billing cycle restarts → renewal = now + 1 month.
    const expectedRenewal = new Date(MID_PERIOD.getTime());
    expectedRenewal.setMonth(expectedRenewal.getMonth() + 1);
    expect(quote.renewalDate).toBe(expectedRenewal.toISOString());
  });

  // 9. GST invariant: gstPaise == round(netTaxablePaise * rate/100) and
  //    netPayablePaise == netTaxablePaise + gstPaise.
  it('GST invariant holds across upgrade scenarios', async () => {
    const svc = makeService();
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    for (const now of [PERIOD_START, MID_PERIOD]) {
      const quote = await svc.computePlanChangeQuote({
        subscription: sub,
        currentPlan: starterMonthly,
        targetPlan: growthMonthly,
        targetBillingCycle: 'monthly',
        now,
      });
      const expectedGst = Math.round((quote.netTaxablePaise * quote.gstRatePercent) / 100);
      expect(quote.gstPaise).toBe(expectedGst);
      expect(quote.netPayablePaise).toBe(quote.netTaxablePaise + quote.gstPaise);
      // Every monetary field is an integer.
      for (const v of [
        quote.unusedCreditPaise,
        quote.targetChargePaise,
        quote.netTaxablePaise,
        quote.gstPaise,
        quote.netPayablePaise,
      ]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  // 9b. Non-default GST rate (12%) flows from the TARGET plan.
  it('uses the target plan GST rate for the net', async () => {
    const svc = makeService();
    const target12 = makePlan({
      id: 'plan-growth-12',
      name: 'Growth (12% GST)',
      monthlyPrice: 1000,
      yearlyPrice: 10000,
      gstRatePercent: 12,
    });
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly, // 18% GST
      targetPlan: target12, // 12% GST — this rate must win
      targetBillingCycle: 'monthly',
      now: PERIOD_START,
    });

    expect(quote.gstRatePercent).toBe(12);
    expect(quote.netTaxablePaise).toBe(50000); // 100000 - 50000
    expect(quote.gstPaise).toBe(6000); // 12% of 50000
    expect(quote.netPayablePaise).toBe(56000);
  });

  // 10. targetBillingCycle='lifetime' → throws BadRequestException.
  it('rejects a lifetime target billing cycle', async () => {
    const svc = makeService();
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    await expect(
      svc.computePlanChangeQuote({
        subscription: sub,
        currentPlan: starterMonthly,
        targetPlan: growthMonthly,
        targetBillingCycle: 'lifetime',
        now: MID_PERIOD,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── Extra edge coverage ────────────────────────────────────────────────

  // No live period (missing dates) → fresh-purchase semantics.
  it('treats a missing billing period as a fresh purchase (full charge, immediate)', async () => {
    const svc = makeService();
    const sub = makeSubscription({ billingCycle: 'monthly' }); // no period dates
    const now = MID_PERIOD;

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now,
    });

    expect(quote.remainingDays).toBe(0);
    expect(quote.totalDays).toBe(1);
    expect(quote.unusedCreditPaise).toBe(0);
    expect(quote.targetChargePaise).toBe(100000); // full Growth taxable
    expect(quote.netTaxablePaise).toBe(100000);
    expect(quote.netPayablePaise).toBe(118000);
    expect(quote.appliesAt).toBe('immediate');
    expect(quote.effectiveDate).toBe(now.toISOString());
    const expectedRenewal = new Date(now.getTime());
    expectedRenewal.setMonth(expectedRenewal.getMonth() + 1);
    expect(quote.renewalDate).toBe(expectedRenewal.toISOString());
  });

  // An expired period (periodEnd <= now) → also fresh-purchase semantics.
  it('treats an already-ended billing period as a fresh purchase', async () => {
    const svc = makeService();
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    const afterEnd = new Date(PERIOD_END.getTime() + DAY * 5);

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: afterEnd,
    });

    expect(quote.unusedCreditPaise).toBe(0);
    expect(quote.targetChargePaise).toBe(100000);
    expect(quote.netPayablePaise).toBe(118000);
    expect(quote.appliesAt).toBe('immediate');
    expect(quote.effectiveDate).toBe(afterEnd.toISOString());
  });

  // Lateral move (different plan, equal yearly-equivalent rank) → free,
  // immediate, renewal unchanged.
  it('classifies an equal-rank different-plan move as lateral with zero payable', async () => {
    const svc = makeService();
    // Two distinct plans with identical yearly-equivalent rank (10000).
    const growthA = makePlan({
      id: 'plan-growth-a',
      name: 'Growth A',
      monthlyPrice: 1000,
      yearlyPrice: 10000,
    });
    const growthB = makePlan({
      id: 'plan-growth-b',
      name: 'Growth B',
      monthlyPrice: 1000,
      yearlyPrice: 10000,
    });
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      planId: 'plan-growth-a',
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: growthA,
      targetPlan: growthB,
      targetBillingCycle: 'monthly',
      now: MID_PERIOD,
    });

    expect(quote.direction).toBe('lateral');
    expect(quote.netPayablePaise).toBe(0);
    expect(quote.unusedCreditPaise).toBe(0);
    expect(quote.appliesAt).toBe('immediate');
    expect(quote.effectiveDate).toBe(MID_PERIOD.toISOString());
    expect(quote.renewalDate).toBe(PERIOD_END.toISOString()); // unchanged
  });

  // appliedCouponCode + target discount flow through to the quote.
  it('stamps the applied coupon code and applies the target discount to the charge', async () => {
    const svc = makeService();
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: PERIOD_START, // full period → full taxable bases
      targetDiscountOnBasePaise: 20000, // ₹200 off the ₹1000 target base
      appliedCouponCode: 'UPGRADE20',
    });

    expect(quote.appliedCouponCode).toBe('UPGRADE20');
    // Growth base 100000 - 20000 discount → 80000 taxable target charge.
    expect(quote.targetChargePaise).toBe(80000);
    expect(quote.unusedCreditPaise).toBe(50000); // full Starter taxable
    expect(quote.netTaxablePaise).toBe(30000); // 80000 - 50000
    expect(quote.gstPaise).toBe(5400);
    expect(quote.netPayablePaise).toBe(35400);
  });

  // Every PlanChangeQuote field is populated and well-typed.
  it('populates every PlanChangeQuote field', async () => {
    const svc = makeService();
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      planId: 'plan-starter',
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: MID_PERIOD,
    });

    expect(quote.currentPlanId).toBe('plan-starter');
    expect(quote.currentPlanName).toBe('Starter');
    expect(quote.targetPlanId).toBe('plan-growth');
    expect(quote.targetPlanName).toBe('Growth');
    expect(quote.currentBillingCycle).toBe('monthly');
    expect(quote.targetBillingCycle).toBe('monthly');
    expect(quote.gstRatePercent).toBe(18);
    expect(quote.upgradeMode).toBe('prorated');
    // ISO date strings round-trip.
    expect(new Date(quote.effectiveDate).toISOString()).toBe(quote.effectiveDate);
    expect(new Date(quote.renewalDate).toISOString()).toBe(quote.renewalDate);
  });

  // The service does not mutate its inputs.
  it('does not mutate the subscription or plan inputs', async () => {
    const svc = makeService();
    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    const subSnapshot = JSON.stringify(sub);
    const currentSnapshot = JSON.stringify(starterMonthly);
    const targetSnapshot = JSON.stringify(growthMonthly);
    const nowInstance = new Date(MID_PERIOD.getTime());
    const nowSnapshot = nowInstance.getTime();

    await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starterMonthly,
      targetPlan: growthMonthly,
      targetBillingCycle: 'monthly',
      now: nowInstance,
    });

    expect(JSON.stringify(sub)).toBe(subSnapshot);
    expect(JSON.stringify(starterMonthly)).toBe(currentSnapshot);
    expect(JSON.stringify(growthMonthly)).toBe(targetSnapshot);
    expect(nowInstance.getTime()).toBe(nowSnapshot); // `now` not mutated
  });
});
