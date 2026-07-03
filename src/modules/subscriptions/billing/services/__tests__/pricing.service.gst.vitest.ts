import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive schema import (Plan) doesn't trip the "Cannot determine type"
// reflection error under the test transform. PricingService injects no model.
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

import { PricingService } from '../pricing.service';
import type { Plan } from '../../../schemas/plan.schema';

/**
 * Optional/configurable subscription-plan GST (Task 3).
 *
 * `plan.gstEnabled === false` must zero out GST entirely (rate 0, gstPaise 0,
 * total == discounted base) on BOTH the exclusive/inclusive path and the
 * fixed-price-override path. `gstEnabled` true / undefined preserves today's
 * always-on 18% behaviour (back-compat: pre-field plans read undefined).
 */
function makePlan(opts: {
  monthlyPrice: number;
  yearlyPrice: number;
  gstEnabled?: boolean;
  gstRatePercent?: number;
  isPriceTaxInclusive?: boolean;
}): Plan {
  return {
    _id: 'plan-1',
    monthlyPrice: opts.monthlyPrice,
    yearlyPrice: opts.yearlyPrice,
    gstEnabled: opts.gstEnabled,
    gstRatePercent: opts.gstRatePercent ?? 18,
    isPriceTaxInclusive: opts.isPriceTaxInclusive ?? false,
    sacCode: '998314',
  } as unknown as Plan;
}

describe('PricingService.computeQuote — optional GST', () => {
  const svc = new PricingService();

  // (a) gstEnabled=false → no GST applied anywhere.
  it('zeroes GST when plan.gstEnabled === false (exclusive base)', () => {
    const plan = makePlan({ monthlyPrice: 1000, yearlyPrice: 12000, gstEnabled: false });
    const quote = svc.computeQuote(plan, 'monthly');

    // ₹1000 = 100000 paise base; no GST added.
    expect(quote.basePricePaise).toBe(100000);
    expect(quote.taxableBasePaise).toBe(100000);
    expect(quote.gstPaise).toBe(0);
    expect(quote.gstRatePercent).toBe(0);
    expect(quote.totalPaise).toBe(100000); // total == base, no GST
    expect(quote.gstEnabled).toBe(false);
  });

  // (a2) gstEnabled=false also skips the inclusive carve — price is taken as-is.
  it('zeroes GST when gstEnabled === false even if isPriceTaxInclusive is true', () => {
    const plan = makePlan({
      monthlyPrice: 1180,
      yearlyPrice: 14160,
      gstEnabled: false,
      isPriceTaxInclusive: true,
    });
    const quote = svc.computeQuote(plan, 'monthly');

    // ₹1180 = 118000 paise; NO reverse carve when GST is disabled.
    expect(quote.taxableBasePaise).toBe(118000);
    expect(quote.gstPaise).toBe(0);
    expect(quote.gstRatePercent).toBe(0);
    expect(quote.totalPaise).toBe(118000);
    expect(quote.gstEnabled).toBe(false);
  });

  // (a3) fixed-price override path with GST disabled → no reverse carve.
  it('zeroes GST on the fixed-price override path when gstEnabled === false', () => {
    const plan = makePlan({ monthlyPrice: 1000, yearlyPrice: 12000, gstEnabled: false });
    const quote = svc.computeQuote(plan, 'monthly', {
      finalTotalOverridePaise: 80000, // coupon sells a final ₹800
    });

    expect(quote.totalPaise).toBe(80000);
    expect(quote.taxableBasePaise).toBe(80000); // whole override is taxable base, no carve
    expect(quote.gstPaise).toBe(0);
    expect(quote.gstRatePercent).toBe(0);
    expect(quote.discountPaise).toBe(20000); // 100000 - 80000
    expect(quote.gstEnabled).toBe(false);
  });

  // (b) gstEnabled=true (explicit) → 18% added on the exclusive base.
  it('adds 18% GST when plan.gstEnabled === true (exclusive base)', () => {
    const plan = makePlan({ monthlyPrice: 1000, yearlyPrice: 12000, gstEnabled: true });
    const quote = svc.computeQuote(plan, 'monthly');

    expect(quote.taxableBasePaise).toBe(100000);
    expect(quote.gstPaise).toBe(18000); // 18% of 100000
    expect(quote.gstRatePercent).toBe(18);
    expect(quote.totalPaise).toBe(118000);
    expect(quote.gstEnabled).toBe(true);
  });

  // (b2) gstEnabled=undefined (pre-field plan) → treated as ON (back-compat).
  it('treats gstEnabled === undefined as ON (back-compat)', () => {
    const plan = makePlan({ monthlyPrice: 1000, yearlyPrice: 12000 }); // no gstEnabled
    const quote = svc.computeQuote(plan, 'monthly');

    expect(quote.gstPaise).toBe(18000);
    expect(quote.gstRatePercent).toBe(18);
    expect(quote.totalPaise).toBe(118000);
    // gstEnabled defaults to ON in the quote.
    expect(quote.gstEnabled).toBe(true);
  });

  // (c) gstEnabled=true + isPriceTaxInclusive=true → GST carved out of the price.
  it('carves GST out of an inclusive price when gstEnabled === true', () => {
    const plan = makePlan({
      monthlyPrice: 1180,
      yearlyPrice: 14160,
      gstEnabled: true,
      isPriceTaxInclusive: true,
    });
    const quote = svc.computeQuote(plan, 'monthly');

    // ₹1180 incl. 18% → taxable 100000, GST 18000, total stays 118000.
    expect(quote.taxableBasePaise).toBe(100000);
    expect(quote.gstPaise).toBe(18000);
    expect(quote.gstRatePercent).toBe(18);
    expect(quote.totalPaise).toBe(118000);
    expect(quote.gstEnabled).toBe(true);
  });
});
