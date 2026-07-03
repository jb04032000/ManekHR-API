import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';
import type {
  ChannelPrefs,
  NotificationCategory,
  GlobalChannelPrefs,
  DeliverySettings,
} from '../notification-categories';
import { defaultGlobalChannels, defaultDeliverySettings } from '../notification-categories';

/**
 * Per-user notification preferences.
 *
 * Sparse — created lazily on first `getOrCreate` lookup with the platform
 * defaults (every user-toggleable category in-platform-on; mobile-push /
 * browser-push opt-in). Users tweak via `PATCH /me/notifications/preferences`.
 *
 * Shape: `prefs` is a flat map `{ [category]: { inPlatform, mobilePush, browserPush } }`.
 * The map grows lazily — new categories added to `USER_TOGGLEABLE_CATEGORIES`
 * are seeded into existing prefs docs on the next `getOrCreate` read via
 * `mergeDefaults` (so a brand-new event type is on-by-default for everyone
 * without a migration).
 */
@Schema({ timestamps: true })
export class NotificationPreferences extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true, index: true })
  userId: User | Types.ObjectId;

  /**
   * Flat map of category → channel toggles. Stored as plain object (not
   * a Map) so Mongoose serialises cleanly + the API surface is JSON-flat.
   *
   * The legacy ERP categories (`INVITE_*`) are NOT user-toggleable — they
   * stay operational. Only categories listed in `USER_TOGGLEABLE_CATEGORIES`
   * are honoured here.
   */
  @Prop({ type: Object, default: () => ({}) })
  prefs: Partial<Record<NotificationCategory, ChannelPrefs>>;

  /**
   * Global delivery channels (additive 2026-06-09). Sparse + lazily defaulted
   * like `prefs`. Only `inApp` is honoured by the dispatcher today; the rest are
   * structure-only so the settings UI persists the user's future choice.
   */
  @Prop({ type: Object, default: () => defaultGlobalChannels() })
  channels: GlobalChannelPrefs;

  /**
   * Smart-delivery settings (additive 2026-06-09). `smartBatching` ties into the
   * existing in-app batching; `quietHours` is stored but not enforced yet.
   */
  @Prop({ type: Object, default: () => defaultDeliverySettings() })
  delivery: DeliverySettings;
}

export const NotificationPreferencesSchema = SchemaFactory.createForClass(NotificationPreferences);
