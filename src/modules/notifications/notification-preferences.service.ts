import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { NotificationPreferences } from './schemas/notification-preferences.schema';
import {
  USER_TOGGLEABLE_CATEGORIES,
  defaultChannelPrefs,
  defaultPreferences,
  defaultGlobalChannels,
  defaultDeliverySettings,
  type ChannelPrefs,
  type NotificationCategory,
  type GlobalChannelPrefs,
  type DeliverySettings,
} from './notification-categories';

/**
 * Persisted preference map returned to the FE. Always covers every
 * user-toggleable category (categories newer than the user's prefs doc
 * are filled with defaults — `mergeDefaults`).
 */
export type UserNotificationPrefs = Record<NotificationCategory, ChannelPrefs>;

/** Full settings envelope returned to the drawer + full preferences page. */
export interface UserNotificationSettings {
  channels: GlobalChannelPrefs;
  delivery: DeliverySettings;
}

@Injectable()
export class NotificationPreferencesService {
  constructor(
    @InjectModel(NotificationPreferences.name)
    private readonly prefsModel: Model<NotificationPreferences>,
  ) {}

  /**
   * Read the user's full preference map, creating a default doc on first
   * access. New categories added to `USER_TOGGLEABLE_CATEGORIES` (after
   * the user's doc was first created) are filled with defaults so the
   * user gets opt-in-by-default for any future event the platform adds.
   */
  async getForUser(userId: string | Types.ObjectId): Promise<UserNotificationPrefs> {
    const uid = this.toObjectId(userId);
    let doc = await this.prefsModel.findOne({ userId: uid }).exec();
    if (!doc) {
      doc = await this.prefsModel.create({ userId: uid, prefs: defaultPreferences() });
    }
    return this.mergeDefaults(doc.prefs ?? {});
  }

  /**
   * Should the dispatcher fire the given channel for this user × category?
   * Categories not in the user's prefs default to the platform defaults
   * (in-platform-on, other channels off). Categories outside the
   * user-toggleable set (`INVITE_*` etc.) bypass prefs entirely — the
   * dispatcher honours them on every channel that supports them.
   */
  async isChannelEnabled(
    userId: string | Types.ObjectId,
    category: NotificationCategory,
    channel: keyof ChannelPrefs,
  ): Promise<boolean> {
    if (!USER_TOGGLEABLE_CATEGORIES.includes(category)) {
      // Operational categories — always on for every channel the dispatcher
      // chooses. (In-platform is the only one wired today; future channels
      // get an explicit allow-list when they're added.)
      return channel === 'inPlatform';
    }
    const prefs = await this.getForUser(userId);
    return prefs[category]?.[channel] ?? defaultChannelPrefs()[channel];
  }

  /**
   * Patch user prefs. Only allows toggling user-toggleable categories;
   * unknown / non-toggleable categories are silently dropped (defence
   * against a malicious or buggy client). Returns the full merged map.
   */
  async update(
    userId: string | Types.ObjectId,
    patch: Partial<Record<string, Partial<ChannelPrefs>>>,
  ): Promise<UserNotificationPrefs> {
    const uid = this.toObjectId(userId);
    const current = await this.getForUser(userId);
    const next: UserNotificationPrefs = { ...current };
    for (const [cat, channels] of Object.entries(patch)) {
      if (!USER_TOGGLEABLE_CATEGORIES.includes(cat as NotificationCategory)) continue;
      const category = cat as NotificationCategory;
      next[category] = {
        ...next[category],
        ...(typeof channels?.inPlatform === 'boolean' ? { inPlatform: channels.inPlatform } : {}),
        ...(typeof channels?.mobilePush === 'boolean' ? { mobilePush: channels.mobilePush } : {}),
        ...(typeof channels?.browserPush === 'boolean'
          ? { browserPush: channels.browserPush }
          : {}),
      };
    }
    await this.prefsModel
      .updateOne({ userId: uid }, { $set: { prefs: next } }, { upsert: true })
      .exec();
    return next;
  }

  /**
   * Read the user's global channel + smart-delivery settings, creating the
   * default doc on first access and back-filling either block on a legacy doc
   * that predates the fields. `inApp` is always coerced on (it is the engine).
   * Pairs with the per-category `getForUser`; the controller returns both.
   */
  async getSettingsForUser(userId: string | Types.ObjectId): Promise<UserNotificationSettings> {
    const uid = this.toObjectId(userId);
    let doc = await this.prefsModel.findOne({ userId: uid }).exec();
    if (!doc) {
      doc = await this.prefsModel.create({ userId: uid, prefs: defaultPreferences() });
    }
    const dc = defaultGlobalChannels();
    const dd = defaultDeliverySettings();
    return {
      channels: { ...dc, ...(doc.channels ?? {}), inApp: true },
      delivery: {
        smartBatching: doc.delivery?.smartBatching ?? dd.smartBatching,
        quietHours: { ...dd.quietHours, ...(doc.delivery?.quietHours ?? {}) },
      },
    };
  }

  /**
   * Patch global channels + smart-delivery. `inApp` can never be turned off
   * (the in-app channel IS the notifications engine). Unknown keys are dropped
   * by the typed spread. Returns the merged settings.
   */
  async updateSettings(
    userId: string | Types.ObjectId,
    patch: { channels?: Partial<GlobalChannelPrefs>; delivery?: Partial<DeliverySettings> },
  ): Promise<UserNotificationSettings> {
    const uid = this.toObjectId(userId);
    const current = await this.getSettingsForUser(userId);
    const nextChannels: GlobalChannelPrefs = {
      ...current.channels,
      ...(patch.channels ?? {}),
      inApp: true, // pinned on
    };
    const nextDelivery: DeliverySettings = {
      smartBatching:
        typeof patch.delivery?.smartBatching === 'boolean'
          ? patch.delivery.smartBatching
          : current.delivery.smartBatching,
      quietHours: { ...current.delivery.quietHours, ...(patch.delivery?.quietHours ?? {}) },
    };
    await this.prefsModel
      .updateOne(
        { userId: uid },
        { $set: { channels: nextChannels, delivery: nextDelivery } },
        { upsert: true },
      )
      .exec();
    return { channels: nextChannels, delivery: nextDelivery };
  }

  /** Fill any user-toggleable categories absent from `stored` with defaults. */
  private mergeDefaults(
    stored: Partial<Record<NotificationCategory, ChannelPrefs>>,
  ): UserNotificationPrefs {
    const merged = {} as UserNotificationPrefs;
    for (const cat of USER_TOGGLEABLE_CATEGORIES) {
      merged[cat] = stored[cat] ?? defaultChannelPrefs();
    }
    return merged;
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return typeof id === 'string' ? new Types.ObjectId(id) : id;
  }
}
