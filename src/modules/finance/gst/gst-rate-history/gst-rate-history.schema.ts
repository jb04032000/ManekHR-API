import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * GstRateHistory — historical GST rate records per HSN/SAC prefix.
 * Supports longest-prefix match rate lookup for any txnDate (D-07).
 * Seed: gst-rates-2017-2026.seed.ts (300+ records from Jul 2017 launch).
 */
@Schema({ timestamps: true })
export class GstRateHistory extends Document {
  /** HSN/SAC prefix (1-8 chars). Longer prefix = more specific = wins in lookup. */
  @Prop({ type: String, required: true })
  hsnPrefix: string;

  /** Human-readable description of goods/services covered by this prefix. */
  @Prop({ type: String })
  description: string;

  /** Date from which this rate is effective (inclusive). */
  @Prop({ type: Date, required: true })
  fromDate: Date;

  /** Date until which this rate is effective (inclusive). Null = currently applicable. */
  @Prop({ type: Date })
  toDate?: Date;

  /** Central GST rate as decimal percentage (e.g. 6 = 6%, half of 12% total). */
  @Prop({ type: Number, required: true })
  cgstRate: number;

  /** State GST rate as decimal percentage (mirrors cgstRate for intra-state). */
  @Prop({ type: Number, required: true })
  sgstRate: number;

  /** Integrated GST rate as decimal percentage (inter-state = cgstRate + sgstRate). */
  @Prop({ type: Number, required: true })
  igstRate: number;

  /** Cess rate as decimal percentage (default 0; applicable for tobacco, luxury goods, etc.). */
  @Prop({ type: Number, default: 0 })
  cessRate: number;

  /** CBIC notification reference, e.g. "Notification 11/2017-CT(Rate) dated 28-06-2017". */
  @Prop({ type: String })
  notification: string;

  // R6: who recorded this revision (platform admin). Null on the 2017-2026 seed rows (system).
  // Surfaced as the "Revised by" audit column in the admin rate editor; "Revised at" uses the
  // timestamps createdAt. The central AuditService event remains the durable audit trail.
  @Prop({ type: String })
  revisedBy?: string;

  @Prop({ type: String })
  revisedByName?: string;
}

export const GstRateHistorySchema = SchemaFactory.createForClass(GstRateHistory);

// Primary lookup index: find all matching prefixes effective at a given date
GstRateHistorySchema.index({ hsnPrefix: 1, fromDate: 1 });
// Secondary index: list all rate changes in a date range (for Verify-My-Data period scan)
GstRateHistorySchema.index({ fromDate: 1 });
