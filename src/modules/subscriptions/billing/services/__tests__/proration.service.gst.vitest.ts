/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the services — see the
// sibling proration.service.vitest.ts for the rationale. Nothing here touches
// Mongoose: PricingService is the real pure service, BillingPolicyService is a
// hand-built mock.
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

function makePlan(opts: {
  id: string;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  gstEnabled?: boolean;
  gstRatePercent?: number;
}): Plan {
  return {
    _id: opts.id,
    name: opts.name,
    monthlyPrice: opts.monthlyPrice,
    yearlyPrice: opts.yearlyPrice,
    gstEnabled: opts.gstEnabled,
    gstRatePercent: opts.gstRatePercent ?? 18,
    isPriceTaxInclusive: false,
    sacCode: '998314',
  } as unknown as Plan;
}

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

function makePolicyService() {
  const policy = {
    proration: {
      upgradeMode: 'prorated',
      downgradeMode: 'cycle_end',
      creditUnusedOnUpgrade: true,
      allowDowngrade: true,
      minProratedChargePaise: 0,
    },
  };
  return { getPolicy: vi.fn().mockResolvedValue(policy) } as any;
}

const PERIOD_START = new Date('2026-01-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-01-31T00:00:00.000Z'); // 30 days
const MID_PERIOD = new Date('2026-01-16T00:00:00.000Z'); // 15 days left

describe('ProrationService — GST disabled propagates rate 0 / gst 0', () => {
  it('zeroes upgrade-proration GST when the TARGET plan has gstEnabled=false', async () => {
    const svc = new ProrationService(new PricingService(), makePolicyService());

    const starter = makePlan({
      id: 'plan-starter',
      name: 'Starter',
      monthlyPrice: 500,
      yearlyPrice: 5000,
      gstEnabled: true,
    });
    const growthNoGst = makePlan({
      id: 'plan-growth',
      name: 'Growth (GST off)',
      monthlyPrice: 1000,
      yearlyPrice: 10000,
      gstEnabled: false,
    });

    const sub = makeSubscription({
      billingCycle: 'monthly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      planId: 'plan-starter',
    });

    const quote = await svc.computePlanChangeQuote({
      subscription: sub,
      currentPlan: starter,
      targetPlan: growthNoGst,
      targetBillingCycle: 'monthly',
      now: MID_PERIOD,
    });

    expect(quote.direction).toBe('upgrade');
    // Target plan GST disabled → rate flows through as 0.
    expect(quote.gstRatePercent).toBe(0);
    expect(quote.gstPaise).toBe(0);
    // Growth taxable 100000 prorated 15/30 → 50000 charge; Starter credit 25000.
    expect(quote.targetChargePaise).toBe(50000);
    expect(quote.unusedCreditPaise).toBe(25000);
    expect(quote.netTaxablePaise).toBe(25000);
    // netPayable == netTaxable (no GST added).
    expect(quote.netPayablePaise).toBe(25000);
  });
});
