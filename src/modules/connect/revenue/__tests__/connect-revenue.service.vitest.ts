/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import { describe, it, expect, vi } from 'vitest';

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

import { ConnectRevenueService } from '../services/connect-revenue.service';

const P1 = '60a0000000000000000000d1';
const P2 = '60a0000000000000000000d2';

function makePlanModel(plans: Array<{ _id: string; name: string; tier: string }>) {
  return {
    find: vi.fn(() => ({
      select: () => ({ lean: () => ({ exec: async () => plans }) }),
    })),
  } as any;
}

function makePaymentModel(rows: any[]) {
  return { aggregate: vi.fn(async () => rows) } as any;
}

describe('ConnectRevenueService.getSubscriptionRevenue', () => {
  it('returns empty when there are no Connect plans', async () => {
    const svc = new ConnectRevenueService(makePaymentModel([]), makePlanModel([]));
    const res = await svc.getSubscriptionRevenue();
    expect(res.subscription.netPaise).toBe(0);
    expect(res.subscription.byPlan).toHaveLength(0);
  });

  it('rolls up captured payments per plan, net of refunds, sorted by net desc', async () => {
    const planModel = makePlanModel([
      { _id: P1, name: 'Connect Premium', tier: 'premium' },
      { _id: P2, name: 'Connect Starter', tier: 'starter' },
    ]);
    const paymentModel = makePaymentModel([
      { _id: P2, grossPaise: 20000, refundedPaise: 0, payments: 2 },
      { _id: P1, grossPaise: 100000, refundedPaise: 15000, payments: 5 },
    ]);
    const svc = new ConnectRevenueService(paymentModel, planModel);

    const res = await svc.getSubscriptionRevenue();

    expect(res.subscription.grossPaise).toBe(120000);
    expect(res.subscription.refundedPaise).toBe(15000);
    expect(res.subscription.netPaise).toBe(105000);
    expect(res.subscription.payments).toBe(7);
    // Premium (net 85000) ranks above Starter (net 20000).
    expect(res.subscription.byPlan[0].planName).toBe('Connect Premium');
    expect(res.subscription.byPlan[0].netPaise).toBe(85000);
    expect(res.subscription.byPlan[1].netPaise).toBe(20000);
  });

  it('only matches captured / partially_refunded payments on connect/bundle plans', async () => {
    const planModel = makePlanModel([{ _id: P1, name: 'Connect Premium', tier: 'premium' }]);
    const paymentModel = makePaymentModel([]);
    const svc = new ConnectRevenueService(paymentModel, planModel);

    await svc.getSubscriptionRevenue();

    const pipeline = paymentModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.status.$in).toEqual(['captured', 'partially_refunded']);
    expect(planModel.find).toHaveBeenCalledWith({ product: { $in: ['connect', 'bundle'] } });
  });
});
