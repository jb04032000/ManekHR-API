import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { NUDGE_DISMISS_DAYS } from '../boost-nudge.constants';
import type { BoostNudgeKind } from '../boost-nudge.types';

/**
 * ManekHR Connect -- a record that an owner dismissed the boost nudge for one
 * specific entity. One row per (owner, kind, entityId) via the unique index, so
 * a repeated dismiss is idempotent (it refreshes the timestamp, never duplicates).
 *
 * Links to: BoostNudgeService.dismiss (writes) and getNudges (reads -- excludes
 * any entity dismissed within the last {@link NUDGE_DISMISS_DAYS} days). The TTL
 * index expires a dismissal exactly when that window lapses, so the entity
 * becomes nudge-eligible again automatically and the collection stays small.
 */
@Schema({ timestamps: true, collection: 'connect_boost_nudge_dismissals' })
export class ConnectBoostNudgeDismissal extends Document {
  /** The owner who dismissed the nudge. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerUserId: Types.ObjectId;

  /** Which entity kind was dismissed. */
  @Prop({ type: String, required: true, enum: ['listing', 'post', 'job'] })
  kind: BoostNudgeKind;

  /** The dismissed entity's id. */
  @Prop({ type: Types.ObjectId, required: true })
  entityId: Types.ObjectId;

  /** When it was dismissed -- drives the 30-day "stays dismissed" window + TTL. */
  @Prop({ type: Date, required: true })
  dismissedAt: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectBoostNudgeDismissalDocument = ConnectBoostNudgeDismissal & Document;

export const ConnectBoostNudgeDismissalSchema = SchemaFactory.createForClass(
  ConnectBoostNudgeDismissal,
);

// One dismissal per (owner, kind, entity) -- idempotent upsert + dedup backstop.
ConnectBoostNudgeDismissalSchema.index({ ownerUserId: 1, kind: 1, entityId: 1 }, { unique: true });
// Owner-scoped recency read ("dismissed in the last 30 days").
ConnectBoostNudgeDismissalSchema.index({ ownerUserId: 1, dismissedAt: -1 });
// Self-expire a dismissal when its 30-day window lapses (the read also filters
// by dismissedAt for exactness, since Mongo's TTL reaper is best-effort).
ConnectBoostNudgeDismissalSchema.index(
  { dismissedAt: 1 },
  { name: 'boost_nudge_dismissal_ttl', expireAfterSeconds: NUDGE_DISMISS_DAYS * 24 * 60 * 60 },
);
