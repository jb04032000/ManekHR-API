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
import { DEFAULT_COMING_SOON_MODULES } from '../schemas/app-settings.schema';

/**
 * Public module-availability config — tells the web which LOCKED modules to
 * present as "Coming Soon" instead of the plan-upgrade prompt. Presentation-
 * only (SubscriptionGuard still 403s). The admin edits the list via
 * PATCH /admin/settings { comingSoonModules }; this public read exposes ONLY
 * that list and leaks nothing else from AppSettings.
 */

// appSettingsModel.findOne() -> { exec } stub returning the single settings doc.
const makeAppSettings = (doc: any) => ({
  findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(doc) })),
});

const buildSvc = (appSettingsModel: any) =>
  new SubscriptionsService(
    {} as any, // planModel
    {} as any, // subscriptionModel
    appSettingsModel, // appSettingsModel
    {} as any, // tierModel
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    {} as any, // addOnsService
    {} as any, // singleFlight
    {} as any, // userModel
    {} as any, // marketing
  );

describe('SubscriptionsService.getPublicModuleAvailability', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the stored comingSoonModules list', async () => {
    const svc = buildSvc(makeAppSettings({ comingSoonModules: ['finance', 'machines'] }));

    const cfg = await svc.getPublicModuleAvailability();

    expect(cfg).toEqual({ comingSoonModules: ['finance', 'machines'] });
  });

  it('falls back to the ManekHR default set when AppSettings doc is absent (fresh DB)', async () => {
    const svc = buildSvc(makeAppSettings(null));

    const cfg = await svc.getPublicModuleAvailability();

    expect(cfg.comingSoonModules).toEqual(DEFAULT_COMING_SOON_MODULES);
    // Attendance group + accounting group + machines group are seeded.
    expect(cfg.comingSoonModules).toContain('attendance');
    expect(cfg.comingSoonModules).toContain('finance');
    expect(cfg.comingSoonModules).toContain('machines');
  });

  it('returns an empty list when the admin cleared every flag', async () => {
    const svc = buildSvc(makeAppSettings({ comingSoonModules: [] }));

    const cfg = await svc.getPublicModuleAvailability();

    expect(cfg).toEqual({ comingSoonModules: [] });
  });

  it('exposes ONLY comingSoonModules (no other settings leak)', async () => {
    const svc = buildSvc(
      makeAppSettings({
        freeTierEnabled: false, // must NOT leak
        defaultBranding: { logo: 'secret.png' }, // must NOT leak
        trialBanner: { enabled: true, headlineOverride: 'Promo' }, // must NOT leak
        comingSoonModules: ['finance'],
      }),
    );

    const cfg = await svc.getPublicModuleAvailability();

    expect(Object.keys(cfg)).toEqual(['comingSoonModules']);
  });
});
