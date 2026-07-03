import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Wave 8 — versioned wholesale cost table for SMS providers.
 *
 * Looked up at every `SmsService.sendDltSms` to populate
 * `SmsDispatchLog.providerCostPaise`. Keyed by `(provider, country, encoding,
 * segments)`. Multiple rows per key may coexist with overlapping
 * `effectiveFrom` / `effectiveTo` — the resolver picks the row whose window
 * contains `now`.
 *
 * Cost-table is authoritative for our books — reconciled monthly against the
 * actual MSG91 invoice via `scripts/reconcile-msg91.ts` (Wave 9). Drift > 3%
 * triggers ops alert.
 */
@Schema({ timestamps: true, collection: 'msg91costtable' })
export class Msg91CostTable extends Document {
  /** 'msg91' for SMS; 'aisensy' for WhatsApp. Drives which provider's invoice this row reconciles against. */
  @Prop({ required: true, default: 'msg91', index: true })
  provider: string;

  /**
   * Wave 8.2 — channel split. SMS rows mirror MSG91 segment-pricing.
   * WhatsApp rows are per-conversation (encoding=N/A, segments=1).
   */
  @Prop({ required: true, enum: ['sms', 'whatsapp'], default: 'sms', index: true })
  channel: string;

  /** ISO-2 country code, e.g. 'IN'. International scopes added as needed. */
  @Prop({ required: true, default: 'IN', index: true })
  country: string;

  /** GSM7 / UCS2 for SMS; 'N/A' for WhatsApp. */
  @Prop({ required: true, enum: ['GSM7', 'UCS2', 'N/A'], default: 'GSM7' })
  encoding: string;

  /** 1, 2, or 3 — MSG91 segment count for SMS; always 1 for WhatsApp conversation. */
  @Prop({ required: true, min: 1, max: 10 })
  segments: number;

  /** Wholesale cost in paise per segment for this combination. */
  @Prop({ required: true, min: 0 })
  costPaise: number;

  /** When this row took effect. Latest non-expired window wins. */
  @Prop({ required: true, default: () => new Date() })
  effectiveFrom: Date;

  /** Optional sunset date. Null = currently active. */
  @Prop({ type: Date, default: null })
  effectiveTo: Date | null;

  /** Optional human-readable note (e.g. "MSG91 Q3 rate hike"). */
  @Prop()
  note?: string;
}

export const Msg91CostTableSchema = SchemaFactory.createForClass(Msg91CostTable);

// Hot path: lookup by (provider, channel, country, encoding, segments) where
// effectiveFrom <= now AND (effectiveTo == null OR effectiveTo > now).
Msg91CostTableSchema.index({
  provider: 1,
  channel: 1,
  country: 1,
  encoding: 1,
  segments: 1,
  effectiveFrom: -1,
});
