import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { NUDGE_SHOWN_COOLDOWN_DAYS } from '../boost-nudge.constants';

/**
 * ManekHR Connect -- the global per-owner cool-down marker. ONE row per owner
 * (unique index), upserted to the current time whenever the web app actually
 * RENDERS a nudge card. While this row exists (i.e. within the cool-down) the
 * owner is shown no further nudges on any surface.
 *
 * Links to: BoostNudgeService.markShown (writes, on POST /me/connect/boost-nudges/shown)
 * and getNudges (reads -- returns no candidates while lastShownAt is within the
 * last {@link NUDGE_SHOWN_COOLDOWN_DAYS} days). The TTL on lastShownAt expires
 * the row exactly when the cool-down lapses, so the next read naturally sees
 * "never shown" and the collection self-cleans.
 */
@Schema({ timestamps: true, collection: 'connect_boost_nudge_shown' })
export class ConnectBoostNudgeShown extends Document {
  /** The owner this cool-down belongs to (one row each). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  ownerUserId: Types.ObjectId;

  /** When a nudge was last shown to this owner -- drives the cool-down + TTL. */
  @Prop({ type: Date, required: true })
  lastShownAt: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectBoostNudgeShownDocument = ConnectBoostNudgeShown & Document;

export const ConnectBoostNudgeShownSchema = SchemaFactory.createForClass(ConnectBoostNudgeShown);

// Self-expire the marker when the 7-day cool-down lapses (the read also filters
// by lastShownAt for exactness, since Mongo's TTL reaper is best-effort).
ConnectBoostNudgeShownSchema.index(
  { lastShownAt: 1 },
  { name: 'boost_nudge_shown_ttl', expireAfterSeconds: NUDGE_SHOWN_COOLDOWN_DAYS * 24 * 60 * 60 },
);
