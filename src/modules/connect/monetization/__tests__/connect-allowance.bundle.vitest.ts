/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const flagState = vi.hoisted(() => ({ enforced: true }));
vi.mock('../../../../config/env', () => ({
  env: {
    connectLimits: {
      get enforced() {
        return flagState.enforced;
      },
    },
  },
}));

import { Types } from 'mongoose';
import { ConnectAllowanceService } from '../connect-allowance.service';

/**
 * Bundle-readiness: Connect allowance resolution must treat a `product:'bundle'`
 * subscription as Connect-eligible, not just `product:'connect'`. The future
 * ERP+Connect bundle stores its Connect caps under `appliedEntitlements.connect`,
 * exactly like a standalone Connect sub — so one query predicate must cover both.
 */
const userId = new Types.ObjectId().toString();
const findOneChain = (result: any) => ({ lean: () => ({ exec: () => Promise.resolve(result) }) });

function build(sub: any) {
  const subModel: any = { findOne: vi.fn(() => findOneChain(sub)) };
  const planModel: any = { findOne: vi.fn(() => findOneChain(null)) };
  const svc = new ConnectAllowanceService(subModel, planModel);
  return { svc, subModel };
}

describe('ConnectAllowanceService — bundle-ready resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagState.enforced = true;
  });

  it('queries connect OR bundle subscriptions (not connect only)', async () => {
    const { svc, subModel } = build({ appliedEntitlements: { connect: { maxCompanyPages: 3 } } });

    const allowances = await svc.getAllowances(userId);

    expect(allowances.maxCompanyPages).toBe(3);
    expect(subModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ product: { $in: ['connect', 'bundle'] } }),
    );
  });
});
