/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the seeder so the
// transitive decorated schema imports (Tier, Plan) do not trip vitest's
// reflect-metadata pipeline. The models are injected as plain mocks.
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

import { SeedConnectTiersAndPlansService } from '../seed-connect-tiers-and-plans';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * M0.4 - Connect tiers + plans seed.
 *
 * Verifies the seeder:
 *   - creates connect_free + connect_premium TIER rows tagged product:'connect'
 *     with CONNECT module access,
 *   - creates the matching PLAN rows tagged product:'connect' with the launch
 *     `connect` allowance block,
 *   - is idempotent (a row that already exists is skipped, never duplicated),
 *   - skips a plan whose tier is missing (defensive).
 */
const makeModelMock = (findOneResult: any) => ({
  findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(findOneResult) })),
  create: vi.fn().mockResolvedValue({}),
});

describe('SeedConnectTiersAndPlansService (M0.4)', () => {
  let tierModel: ReturnType<typeof makeModelMock>;
  let planModel: ReturnType<typeof makeModelMock>;

  const build = (tierFindOne: any, planFindOne: any) => {
    tierModel = makeModelMock(tierFindOne);
    planModel = makeModelMock(planFindOne);
    return new SeedConnectTiersAndPlansService(tierModel as any, planModel as any);
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seedTiers creates connect_free + connect_premium as product:connect with CONNECT module access', async () => {
    const svc = build(null, null); // no tier exists yet

    const result = await svc.seedTiers();

    expect(result).toEqual({ inserted: 2, skipped: 0 });
    expect(tierModel.create).toHaveBeenCalledTimes(2);

    const keys = tierModel.create.mock.calls.map((c: any[]) => c[0].key);
    expect(keys).toEqual(['connect_free', 'connect_premium']);

    for (const call of tierModel.create.mock.calls) {
      const doc = call[0];
      expect(doc.product).toBe('connect');
      expect(doc.defaultModuleAccess[0].module).toBe(AppModule.CONNECT);
      expect(doc.defaultModuleAccess[0].enabled).toBe(true);
      // person-centric: no workspace allowances.
      expect(doc.defaultEntitlements.maxWorkspaces).toBe(0);
    }
  });

  it('seedTiers is idempotent (existing tiers are skipped, none created)', async () => {
    const svc = build({ _id: 'existing-tier' }, null);

    const result = await svc.seedTiers();

    expect(result).toEqual({ inserted: 0, skipped: 2 });
    expect(tierModel.create).not.toHaveBeenCalled();
  });

  it('seedPlans creates connect plans tagged product:connect with the launch connect allowance block', async () => {
    // No existing plan; the tier lookup resolves (tiers already seeded).
    const svc = build({ key: 'connect_free' }, null);

    const result = await svc.seedPlans();

    expect(result).toEqual({ inserted: 2, skipped: 0 });
    expect(planModel.create).toHaveBeenCalledTimes(2);

    const free = planModel.create.mock.calls[0][0];
    expect(free.product).toBe('connect');
    expect(free.monthlyPrice).toBe(0);
    expect(free.entitlements.modules).toContain(AppModule.CONNECT);
    expect(free.entitlements.connect).toMatchObject({
      maxListings: 25,
      leadsPerMonth: -1,
      verifiedBadge: false,
    });

    const premium = planModel.create.mock.calls[1][0];
    expect(premium.product).toBe('connect');
    expect(premium.monthlyPrice).toBe(499);
    expect(premium.entitlements.connect).toMatchObject({
      maxListings: -1,
      includedBoostCredits: 500,
      verifiedBadge: true,
      searchPriority: 10,
    });
  });

  it('seedPlans is idempotent (existing plans are skipped, none created)', async () => {
    const svc = build({ key: 'connect_free' }, { _id: 'existing-plan' });

    const result = await svc.seedPlans();

    expect(result).toEqual({ inserted: 0, skipped: 2 });
    expect(planModel.create).not.toHaveBeenCalled();
  });

  it('seedPlans skips a plan when its tier is missing (defensive)', async () => {
    const svc = build(null, null); // no plan, but tier lookup also returns null

    const result = await svc.seedPlans();

    expect(result).toEqual({ inserted: 0, skipped: 2 });
    expect(planModel.create).not.toHaveBeenCalled();
  });
});
