/* eslint-disable @typescript-eslint/no-explicit-any -- vitest model mocks intentionally any-typed */
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationPreferencesService } from '../notification-preferences.service';
import { USER_TOGGLEABLE_CATEGORIES } from '../notification-categories';

describe('NotificationPreferencesService', () => {
  let prefsModel: any;
  let stored: any;
  const userId = new Types.ObjectId();

  function build(): NotificationPreferencesService {
    return new NotificationPreferencesService(prefsModel);
  }

  beforeEach(() => {
    stored = null;
    prefsModel = {
      findOne: vi.fn(() => ({
        exec: () => Promise.resolve(stored),
      })),
      create: vi.fn((doc: any) => {
        stored = doc;
        return Promise.resolve(doc);
      }),
      updateOne: vi.fn(() => ({
        exec: () => Promise.resolve({}),
      })),
    };
  });

  it('creates a default-on-for-inPlatform doc on first read', async () => {
    const service = build();
    const prefs = await service.getForUser(userId);
    expect(prefsModel.create).toHaveBeenCalledTimes(1);
    for (const cat of USER_TOGGLEABLE_CATEGORIES) {
      expect(prefs[cat]).toEqual({ inPlatform: true, mobilePush: false, browserPush: false });
    }
  });

  it('reads existing prefs without recreating', async () => {
    stored = {
      prefs: {
        'connect.connection_requested': {
          inPlatform: false,
          mobilePush: false,
          browserPush: false,
        },
      },
    };
    const service = build();
    const prefs = await service.getForUser(userId);
    expect(prefsModel.create).not.toHaveBeenCalled();
    expect(prefs['connect.connection_requested'].inPlatform).toBe(false);
  });

  it('fills missing categories with defaults (forward-compat)', async () => {
    stored = {
      prefs: {
        'connect.connection_requested': {
          inPlatform: false,
          mobilePush: false,
          browserPush: false,
        },
      },
    };
    const service = build();
    const prefs = await service.getForUser(userId);
    // A new category (say, post_reacted) that the user has no stored entry
    // for should still appear in the merged result with platform defaults.
    expect(prefs['connect.post_reacted']).toEqual({
      inPlatform: true,
      mobilePush: false,
      browserPush: false,
    });
  });

  it('isChannelEnabled returns true for operational (non-toggleable) categories', async () => {
    const service = build();
    expect(await service.isChannelEnabled(userId, 'INVITE_RECEIVED', 'inPlatform')).toBe(true);
    // Non-in-platform channels for operational categories: false (no provider).
    expect(await service.isChannelEnabled(userId, 'INVITE_RECEIVED', 'mobilePush')).toBe(false);
  });

  it('update silently drops unknown / non-toggleable categories', async () => {
    const service = build();
    await service.getForUser(userId); // seed default doc
    await service.update(userId, {
      'connect.connection_requested': { inPlatform: false },
      INVITE_RECEIVED: { inPlatform: false }, // operational — must be ignored
      'made.up.category': { inPlatform: false }, // unknown — must be ignored
    });
    const writeArg = prefsModel.updateOne.mock.calls[0][1].$set.prefs;
    expect(writeArg['connect.connection_requested'].inPlatform).toBe(false);
    expect(writeArg['INVITE_RECEIVED']).toBeUndefined();
    expect(writeArg['made.up.category']).toBeUndefined();
  });

  it('getSettingsForUser returns default channels + delivery on first read', async () => {
    const service = build();
    const settings = await service.getSettingsForUser(userId);
    expect(settings.channels).toEqual({
      inApp: true,
      browserPush: false,
      whatsapp: false,
      email: false,
      sms: false,
    });
    expect(settings.delivery).toEqual({
      smartBatching: true,
      quietHours: { enabled: false, start: '22:00', end: '07:00', tz: 'Asia/Kolkata' },
    });
  });

  it('getSettingsForUser fills missing blocks on a legacy (pre-field) doc', async () => {
    stored = { prefs: {} }; // legacy doc: no channels/delivery
    const service = build();
    const settings = await service.getSettingsForUser(userId);
    expect(settings.channels.inApp).toBe(true);
    expect(settings.delivery.quietHours.tz).toBe('Asia/Kolkata');
  });

  it('updateSettings merges channels + delivery and pins inApp on', async () => {
    const service = build();
    await service.getSettingsForUser(userId); // seed
    const next = await service.updateSettings(userId, {
      channels: { whatsapp: true, inApp: false }, // inApp:false must be ignored
      delivery: { quietHours: { enabled: true } },
    });
    expect(next.channels.whatsapp).toBe(true);
    expect(next.channels.inApp).toBe(true); // pinned
    expect(next.delivery.quietHours.enabled).toBe(true);
    expect(next.delivery.quietHours.start).toBe('22:00'); // preserved
    const writeArg = prefsModel.updateOne.mock.calls.at(-1)[1].$set;
    expect(writeArg.channels.whatsapp).toBe(true);
    expect(writeArg.delivery.quietHours.enabled).toBe(true);
  });
});
