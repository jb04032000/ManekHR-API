import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { CONNECT_VIEW_TARGET_TYPES, type ConnectViewTargetType } from './connect-view-daily.schema';

/**
 * `ConnectViewSeen` -- one row per (viewer, target, UTC day): dedupe so a viewer
 * refreshing a storefront / product all day counts as a single view. The unique
 * index is the dedupe gate (a duplicate insert throws 11000 -> no increment),
 * and a TTL on `createdAt` self-prunes the collection (no cron) once the day is
 * well past, since only "today" is ever consulted.
 */
@Schema({ timestamps: false, collection: 'connect_view_seen' })
export class ConnectViewSeen extends Document {
  @Prop({ type: String, enum: CONNECT_VIEW_TARGET_TYPES, required: true })
  targetType: ConnectViewTargetType;

  @Prop({ type: Types.ObjectId, required: true })
  targetId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  viewerUserId: User | Types.ObjectId;

  /** UTC calendar day, 'YYYY-MM-DD'. */
  @Prop({ type: String, required: true })
  date: string;

  /** Drives the TTL expiry. */
  @Prop({ type: Date, default: Date.now })
  createdAt: Date;
}

export const ConnectViewSeenSchema = SchemaFactory.createForClass(ConnectViewSeen);

// One impression per (viewer, target, day) -- the dedupe key.
ConnectViewSeenSchema.index(
  { targetType: 1, targetId: 1, viewerUserId: 1, date: 1 },
  { unique: true },
);
// TTL -- 40 days, so the dedupe set stays bounded (only "today" is read).
ConnectViewSeenSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3_456_000 });
