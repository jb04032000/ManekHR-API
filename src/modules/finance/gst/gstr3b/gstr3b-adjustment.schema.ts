import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Gstr3bAdjustment — stores manual override values for GSTR-3B cells per period.
 *
 * Each record holds a map of cell-key → paise override for a single
 * (workspaceId, firmId, period) combination. The unique compound index
 * enforces one-record-per-period (Wave 3 service uses upsert).
 *
 * period format: 'MMYYYY' (e.g. '042025' for April 2025).
 * adjustments keys: GSTR-3B table section identifiers, e.g. '3_1_a_taxableValue',
 * '3_2_1_igst', '4_A_1_igst' etc (defined in Wave 3 builder).
 */
@Schema({ timestamps: true })
export class Gstr3bAdjustment extends Document {
  @Prop({ type: Types.ObjectId, required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  firmId: Types.ObjectId;

  /** Period in 'MMYYYY' format, e.g. '042025' = April 2025. */
  @Prop({ type: String, required: true })
  period: string;

  /** Cell-key → paise override map. Keys are GSTR-3B section identifiers. */
  @Prop({ type: Object, default: {} })
  adjustments: Record<string, number>;

  /** Optional narration / reason for the manual adjustment. */
  @Prop({ type: String })
  narration?: string;

  /** UserId of the person who last saved these adjustments. */
  @Prop({ type: Types.ObjectId })
  savedBy: Types.ObjectId;
}

export const Gstr3bAdjustmentSchema = SchemaFactory.createForClass(Gstr3bAdjustment);

// Unique compound index: one adjustment record per (workspace, firm, period)
// Wave 3 service uses findOneAndUpdate with upsert:true to maintain this invariant.
Gstr3bAdjustmentSchema.index(
  { workspaceId: 1, firmId: 1, period: 1 },
  { unique: true },
);
