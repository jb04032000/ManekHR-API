/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalizationController } from '../localization.controller';

describe('LocalizationController', () => {
  let svc: any;
  let ctrl: LocalizationController;

  beforeEach(() => {
    svc = {
      getTranslationsIndex: vi.fn().mockResolvedValue({
        tuples: [],
        totalKeys: 0,
        withMetadataPercent: 0,
      }),
      getTranslations: vi.fn().mockResolvedValue([]),
      upsertTranslation: vi.fn().mockResolvedValue({ _id: 't1' }),
    };
    ctrl = new LocalizationController(svc);
  });

  it('GET /admin/translations/index forwards full query bag to service', async () => {
    await ctrl.getTranslationsIndex({
      langCode: 'gu-en',
      module: 'team',
      screen: 'team.list',
      feature: 'header',
    });
    expect(svc.getTranslationsIndex).toHaveBeenCalledWith({
      langCode: 'gu-en',
      module: 'team',
      screen: 'team.list',
      feature: 'header',
    });
  });

  it('GET /admin/translations/index forwards empty params (no filters)', async () => {
    await ctrl.getTranslationsIndex({});
    expect(svc.getTranslationsIndex).toHaveBeenCalledWith({
      langCode: undefined,
      module: undefined,
      screen: undefined,
      feature: undefined,
    });
  });

  it('GET /admin/:langCode/translations passes new screen+feature filters', async () => {
    await ctrl.getTranslations('en', 'team', 'web', 'team.list', 'header');
    expect(svc.getTranslations).toHaveBeenCalledWith('en', 'team', 'web', 'team.list', 'header');
  });

  it('PUT :langCode/:namespace/:key passes metadata bag through', async () => {
    const dto: any = {
      value: 'Hello',
      platforms: ['web'],
      description: 'greeting',
      screen: 'auth.login',
      feature: 'hero',
      componentRef: 'LoginCard',
      tags: ['phase-1a'],
    };
    const req: any = { user: { sub: 'user1' } };
    await ctrl.upsertTranslation('en', 'auth', 'login.title', dto, req);
    expect(svc.upsertTranslation).toHaveBeenCalledWith(
      'en',
      'auth',
      'login.title',
      'Hello',
      'user1',
      ['web'],
      {
        description: 'greeting',
        screen: 'auth.login',
        feature: 'hero',
        componentRef: 'LoginCard',
        tags: ['phase-1a'],
      },
    );
  });

  it('PUT :langCode/:namespace/:key passes empty metadata when none provided', async () => {
    const dto: any = { value: 'Hi', platforms: ['web'] };
    const req: any = { user: { sub: 'user1' } };
    await ctrl.upsertTranslation('en', 'auth', 'login.title', dto, req);
    const call = svc.upsertTranslation.mock.calls[0];
    expect(call[6]).toEqual({
      description: undefined,
      screen: undefined,
      feature: undefined,
      componentRef: undefined,
      tags: undefined,
    });
  });
});
