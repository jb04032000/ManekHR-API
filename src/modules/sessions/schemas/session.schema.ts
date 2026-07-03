import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum SessionPlatform {
  WEB = 'web',
  MOBILE = 'mobile',
}

/**
 * One row per device login. This is BOTH live-session state AND the login
 * audit trail (device / IP / userAgent / lastActiveAt are security forensics —
 * Bucket D in DATA-MAP-AND-RETENTION.md).
 *
 * OQ-4 (auth-hardening): session-row retention is DECOUPLED from JWT lifetime.
 *  - The transient `jwtTokenHash` (Bucket C) is meaningful only until the
 *    token expires. The row's audit fields (Bucket D) must survive for the
 *    1-year DPDP traffic-log window.
 *  - So the TTL index now fires off `retainUntil` (= 1 year from when the
 *    session was cleared/expired), NOT `expiresAt` (= 7-day JWT lifetime).
 *    `expiresAt` is kept as the JWT-lifetime marker the cleanup cron reads to
 *    flip `isActive:false`; deletion is governed by `retainUntil`.
 */
@Schema({ timestamps: true })
export class Session extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, index: true })
  workspaceId?: Types.ObjectId;

  @Prop({ required: true })
  jwtTokenHash: string;

  @Prop({ type: String, enum: SessionPlatform, default: SessionPlatform.WEB })
  platform: SessionPlatform;

  @Prop({ required: true })
  deviceName: string;

  @Prop()
  ipAddress: string;

  @Prop()
  location: string;

  @Prop()
  userAgent: string;

  @Prop({ type: Date, default: Date.now })
  lastActiveAt: Date;

  /**
   * JWT-lifetime marker (~7 days from issue). The hourly cleanup cron flips
   * `isActive:false` once this passes; the row itself is NOT deleted here.
   * Bucket C semantics (transient): once past, the row no longer represents a
   * usable session.
   */
  @Prop({ type: Date })
  expiresAt: Date;

  /**
   * OQ-4: when the row should be hard-deleted = 1 year after the session was
   * cleared (deactivated / JWT expired). Backs the TTL index below so the
   * device/IP/userAgent audit fields (Bucket D) are retained for the DPDP
   * 1-year traffic-log minimum, then auto-purged. Set by the session-retention
   * cron when it clears `jwtTokenHash` on an expired/inactive row.
   */
  @Prop({ type: Date })
  retainUntil?: Date;

  @Prop({ default: true })
  isActive: boolean;
}

export const SessionSchema = SchemaFactory.createForClass(Session);

SessionSchema.index({ userId: 1, isActive: 1 });
SessionSchema.index({ jwtTokenHash: 1 });
// OQ-4: TTL now fires off `retainUntil` (1-year audit window), NOT `expiresAt`
// (7-day JWT lifetime). Sparse so a live row (retainUntil unset) is never
// touched by the TTL monitor — only cleared rows carry a retainUntil and thus
// a deletion clock. MIGRATION 0040 drops the old `expiresAt` TTL index and
// stamps retainUntil on already-expired rows so nothing is orphaned.
SessionSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0, sparse: true });
