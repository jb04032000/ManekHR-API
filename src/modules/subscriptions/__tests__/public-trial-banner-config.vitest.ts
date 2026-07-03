/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so transitive
// decorated schema imports do not trip vitest's reflect-metadata pipeline.
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
// @nestjs/schedule's @Cron decorator is applied at class-eval time on the service.
vi.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));

import { SubscriptionsService } from '../subscriptions.service';

/**
 * Public trial-banner config — drives the "45-day free trial" promo banner on
 * BOTH the in-app plans page (authenticated, non-admin) and the PUBLIC
 * marketing pricing page (unauthenticated). The existing GET /admin/settings
 * read is admin-only, so this public-safe read exposes ONLY three fields:
 *   - enabled          (appSettings.trialBanner.enabled, default true)
 *   - headlineOverride (appSettings.trialBanner.headlineOverride, default '')
 *   - days             (the DEFAULT erp plan's trialDurationDays, default 0)
 * No other settings leak.
 */

// appSettingsModel.findOne() -> { exec } stub returning the single settings doc.
const makeAppSettings = (doc: any) => ({
  findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) })),
});

// planModel stub: findOne drives getDefaultPlanId(); findById loads the plan.
const makePlanModel = (defaultId: any, plan: any) => ({
  findOne: vi.fn(() => ({
    exec: vi.fn().mockResolvedValue(defaultId ? { _id: defaultId } : null),
  })),
  findById: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(plan) })),
});

const buildSvc = (deps: { planModel?: any; appSettingsModel?: any }) =>
  new SubscriptionsService(
    deps.planModel ?? ({} as any), // planModel
    {} as any, // subscriptionModel
    deps.appSettingsModel ?? ({} as any), // appSettingsModel
    {} as any, // tierModel
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    {} as any, // addOnsService
    {} as any, // singleFlight
    {} as any, // userModel
    {} as any, // marketing
  );

describe('SubscriptionsService.getPublicTrialBannerConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns enabled/headlineOverride from trialBanner + days from the default plan', async () => {
    const svc = buildSvc({
      appSettingsModel: makeAppSettings({
        trialBanner: { enabled: false, headlineOverride: 'Hi' },
      }),
      planModel: makePlanModel('default-plan', { trialDurationDays: 45 }),
    });

    const cfg = await svc.getPublicTrialBannerConfig();

    expect(cfg).toEqual({ enabled: false, headlineOverride: 'Hi', days: 45 });
    // Resolved the default plan via getDefaultPlanId('erp') -> findById.
    expect((svc as any).planModel.findById).toHaveBeenCalledWith('default-plan');
  });

  it('defaults enabled=true and headlineOverride="" when trialBanner is missing', async () => {
    const svc = buildSvc({
      appSettingsModel: makeAppSettings({}), // settings doc with no trialBanner
      planModel: makePlanModel('default-plan', { trialDurationDays: 30 }),
    });

    const cfg = await svc.getPublicTrialBannerConfig();

    expect(cfg).toEqual({ enabled: true, headlineOverride: '', days: 30 });
  });

  it('returns days=0 (no throw) when no default/free plan exists', async () => {
    const svc = buildSvc({
      appSettingsModel: makeAppSettings({
        trialBanner: { enabled: true, headlineOverride: '' },
      }),
      planModel: makePlanModel(null, null), // no default and no free plan
    });

    const cfg = await svc.getPublicTrialBannerConfig();

    expect(cfg).toEqual({ enabled: true, headlineOverride: '', days: 0 });
  });

  it('returns days=0 when the resolved plan has no trialDurationDays', async () => {
    const svc = buildSvc({
      appSettingsModel: makeAppSettings({
        trialBanner: { enabled: true, headlineOverride: '' },
      }),
      planModel: makePlanModel('default-plan', {}), // plan without trialDurationDays
    });

    const cfg = await svc.getPublicTrialBannerConfig();

    expect(cfg.days).toBe(0);
  });

  it('returns enabled=true/headlineOverride="" when AppSettings doc is absent', async () => {
    const svc = buildSvc({
      appSettingsModel: makeAppSettings(null), // no settings doc at all
      planModel: makePlanModel('default-plan', { trialDurationDays: 45 }),
    });

    const cfg = await svc.getPublicTrialBannerConfig();

    expect(cfg).toEqual({ enabled: true, headlineOverride: '', days: 45 });
  });

  it('exposes ONLY the three public-safe fields (no other settings leak)', async () => {
    const svc = buildSvc({
      appSettingsModel: makeAppSettings({
        freeTierEnabled: false, // must NOT leak
        defaultBranding: { logo: 'secret.png' }, // must NOT leak
        trialBanner: { enabled: true, headlineOverride: 'Promo' },
      }),
      planModel: makePlanModel('default-plan', { trialDurationDays: 45 }),
    });

    const cfg = await svc.getPublicTrialBannerConfig();

    expect(Object.keys(cfg).sort()).toEqual(['days', 'enabled', 'headlineOverride']);
  });
});
