/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AdminService so transitive
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
vi.mock('../../subscriptions/subscriptions.service', () => ({ SubscriptionsService: class {} }));
vi.mock('../../add-ons/add-ons.service', () => ({ AddOnsService: class {} }));
vi.mock('../../audit/audit.service', () => ({ AuditService: class {} }));

import { AdminService } from '../admin.service';

/**
 * Upfront-vs-installments pricing rework — the 45-day trial BANNER is an
 * admin-dynamic lever stored on AppSettings as a `trialBanner` sub-doc
 * ({ enabled, headlineOverride }). The admin reads/sets it through the same
 * generic settings-patch path used for `freeTierEnabled`
 * (GET/PATCH /admin/settings -> getSettings/updateSettings), which $sets the
 * whole DTO. These specs lock that the trialBanner flows through that path.
 */
const build = (appSettingsModel: any) => {
  const svc = new AdminService(
    {} as any, // userModel
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    {} as any, // subscriptionModel
    {} as any, // planModel
    appSettingsModel, // appSettingsModel
    {} as any, // tierModel
    {} as any, // ptSlabConfigModel
    {} as any, // subscriptionsService
    {} as any, // addOnsService
    {} as any, // auditService
    {} as any, // userClaimsCache
    {} as any, // connectProfileModel
  );
  return svc;
};

describe('AdminService trialBanner settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists trialBanner.enabled=false + headlineOverride via updateSettings ($set whole dto)', async () => {
    const persisted = {
      freeTierEnabled: true,
      trialBanner: { enabled: false, headlineOverride: 'Limited launch offer' },
    };
    const appSettingsModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue({ _id: 's1' }) }),
      findOneAndUpdate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(persisted) }),
      create: vi.fn(),
    };
    const svc = build(appSettingsModel);

    const dto = {
      freeTierEnabled: true,
      trialBanner: { enabled: false, headlineOverride: 'Limited launch offer' },
    };
    const result = await svc.updateSettings(dto as any);

    // The generic settings-patch $sets the whole DTO -> trialBanner included.
    expect(appSettingsModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = appSettingsModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({});
    expect(update).toEqual({ $set: dto });
    expect(update.$set.trialBanner).toEqual({
      enabled: false,
      headlineOverride: 'Limited launch offer',
    });
    expect(result.trialBanner).toEqual({
      enabled: false,
      headlineOverride: 'Limited launch offer',
    });
  });

  it('reads trialBanner back via getSettings', async () => {
    const stored = {
      freeTierEnabled: true,
      trialBanner: { enabled: false, headlineOverride: 'Custom text' },
    };
    const appSettingsModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(stored) }),
    };
    const svc = build(appSettingsModel);

    const result = await svc.getSettings();
    expect(result.trialBanner).toEqual({ enabled: false, headlineOverride: 'Custom text' });
  });
});

/**
 * Schema-default sanity — a fresh AppSettings defaults the trialBanner to
 * { enabled: true, headlineOverride: '' }. We capture the `@Prop` options via
 * the decorator-mock pattern (importing the real schema with live decorators
 * trips vitest's reflect-metadata pipeline).
 */
describe('AppSettings trialBanner schema default', () => {
  it('declares trialBanner default = { enabled: true, headlineOverride: "" }', async () => {
    const propDefaults: Record<string, unknown> = {};
    vi.resetModules();
    vi.doMock('@nestjs/mongoose', () => ({
      Prop: (opts?: { default?: unknown }) => (_target: object, propertyKey: string) => {
        if (opts && 'default' in opts) {
          propDefaults[propertyKey] = opts.default;
        }
        return undefined;
      },
      Schema: () => () => undefined,
      SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    }));
    await import('../../subscriptions/schemas/app-settings.schema');
    // The default may be declared as a thunk (`default: () => ({...})`) or a
    // literal object; normalize both before asserting.
    const raw = propDefaults.trialBanner;
    const value = typeof raw === 'function' ? (raw as () => unknown)() : raw;
    expect(value).toEqual({ enabled: true, headlineOverride: '' });
    vi.doUnmock('@nestjs/mongoose');
    vi.resetModules();
  });
});
