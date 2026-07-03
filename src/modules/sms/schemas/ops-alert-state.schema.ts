import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Wave 8.1 — singleton-per-key throttle anchor for ops-channel alerts.
 *
 * Prevents pager spam during a sustained MSG91 outage: when an ops alert
 * fires, `lastFiredAt` updates; subsequent alerts for the same `key` within
 * the throttle window (default 7d, override via `OPS_ALERT_THROTTLE_DAYS`)
 * are suppressed.
 *
 * Keys mirror existing low-balance alert pattern. Currently used:
 *   - `msg91_topup_needed` — single key for both `pack_purchase` and
 *     `send_skipped` triggers (same incident, no double-paging).
 */
@Schema({ timestamps: true, collection: 'opsalertstates' })
export class OpsAlertState extends Document {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ type: Date })
  lastFiredAt?: Date;

  /** Optional latest context payload for ops dashboard display. */
  @Prop({ type: Object })
  lastContext?: Record<string, unknown>;
}

export const OpsAlertStateSchema = SchemaFactory.createForClass(OpsAlertState);
