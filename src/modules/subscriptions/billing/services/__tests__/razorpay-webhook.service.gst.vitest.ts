/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service — the schema
// imports it pulls in carry @Prop/@Schema decorations that trip vitest's
// reflect-metadata pipeline. We never touch Mongoose here: the service is
// constructed with null deps and only its pure GST-computation seam is driven.
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

import { RazorpayWebhookService } from '../razorpay-webhook.service';
import type { Plan } from '../../../schemas/plan.schema';

function makePlan(opts: { gstEnabled?: boolean; gstRatePercent?: number }): Plan {
  return {
    _id: 'plan-x',
    gstEnabled: opts.gstEnabled,
    gstRatePercent: opts.gstRatePercent ?? 18,
  } as unknown as Plan;
}

// Construct the service with null deps — the constructor only stores refs and
// the GST seam under test reads none of them.
function makeService(): RazorpayWebhookService {
  return new RazorpayWebhookService(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );
}

// Reach into the private GST-computation seam used by the recurring auto-renew
// handler. Mirrors the bracket-access pattern used in sibling billing tests.
function computeGst(svc: RazorpayWebhookService, plan: Plan | null, amountPaise: number) {
  return (svc as any).computeRecurringChargeGst(plan, amountPaise);
}

describe('RazorpayWebhookService — recurring-charge GST honours plan.gstEnabled', () => {
  it('zeroes GST when the plan has gstEnabled === false (no phantom carve)', () => {
    const svc = makeService();
    const result = computeGst(svc, makePlan({ gstEnabled: false }), 100000);
    // Disabled → whole charge is the taxable base, no tax carved.
    expect(result.gstRatePercent).toBe(0);
    expect(result.gstPortion).toBe(0);
    expect(result.taxableBase).toBe(100000);
  });

  it('carves 18% out of the charge when gstEnabled === true', () => {
    const svc = makeService();
    // 118000 inclusive of 18% → base 100000, gst 18000.
    const result = computeGst(svc, makePlan({ gstEnabled: true }), 118000);
    expect(result.gstRatePercent).toBe(18);
    expect(result.taxableBase).toBe(100000);
    expect(result.gstPortion).toBe(18000);
  });

  it('treats gstEnabled === undefined as ON (back-compat with pre-field plans)', () => {
    const svc = makeService();
    const result = computeGst(svc, makePlan({}), 118000);
    expect(result.gstRatePercent).toBe(18);
    expect(result.taxableBase).toBe(100000);
    expect(result.gstPortion).toBe(18000);
  });

  it('defaults rate to 18 when the plan row is missing (defensive)', () => {
    const svc = makeService();
    const result = computeGst(svc, null, 118000);
    expect(result.gstRatePercent).toBe(18);
    expect(result.taxableBase).toBe(100000);
    expect(result.gstPortion).toBe(18000);
  });
});
