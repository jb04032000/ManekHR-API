import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * UserDevice — registered push-notification target for a user.
 *
 * One row per (user, FCM token) pair. A single user may have multiple devices
 * (phone + tablet). Tokens are upserted on each register call so a token that
 * rotates server-side (Firebase token refresh) is updated in place; if a
 * physical device wipes the app and re-registers with a new token, a new row
 * is created and the old one is pruned by the failure path in
 * `UserDevicesService.pushUser` when FCM responds
 * `messaging/registration-token-not-registered`.
 */
export type DevicePlatform = 'ios' | 'android' | 'web';

@Schema({ timestamps: true, collection: 'userdevices' })
export class UserDevice extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  // Indexed (UNIQUE) by `UserDeviceSchema.index({ fcmToken: 1 }, { unique: true })`
  // below — do NOT also put `index`/`unique` here. Declaring it both ways made
  // Mongoose warn "Duplicate schema index on {fcmToken:1}" and registered a
  // redundant non-unique index alongside the unique one. Keep this @Prop and that
  // .index() call in sync if either is edited during a merge.
  @Prop({ type: String, required: true })
  fcmToken: string;

  @Prop({ type: String, enum: ['ios', 'android', 'web'], required: true })
  platform: DevicePlatform;

  @Prop({ type: String })
  deviceName?: string;

  @Prop({ type: String })
  appVersion?: string;

  @Prop({ type: Date, default: () => new Date() })
  lastUsedAt: Date;
}

export const UserDeviceSchema = SchemaFactory.createForClass(UserDevice);

// One token may belong to exactly one user. If a different user signs in on
// the same device, the upsert path moves the row to the new user.
// SINGLE source of the {fcmToken:1} index — the @Prop above intentionally omits
// `index`/`unique` so this is the only declaration (no duplicate-index warning).
UserDeviceSchema.index({ fcmToken: 1 }, { unique: true });
// Hot-path query: load all of a user's active devices.
UserDeviceSchema.index({ userId: 1, lastUsedAt: -1 });
