import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * CessRule — D-08 GST Cess Registry
 *
 * Stores GST Council cess rate rules keyed by HSN prefix (2–8 digits).
 * The service uses longest-prefix matching: HSN 24021000 matches rule '2402'
 * over rule '24', selecting the most specific applicable cess rate.
 *
 * cessType variants:
 *   ad_valorem  — percentage of taxable value (e.g. aerated drinks: 12%)
 *   specific    — fixed amount per unit (e.g. coal: ₹400/tonne)
 *   compound    — ad_valorem + specific combined (e.g. cigarettes: 5% + ₹41.70/piece)
 */
@Schema({ collection: 'cess_rules', timestamps: true })
export class CessRule {
  /** 2–8 digit HSN prefix used for longest-prefix matching */
  @Prop({ type: String, required: true, index: true })
  hsnCode: string;

  @Prop({ type: String, required: true })
  description: string;

  @Prop({ type: String, enum: ['ad_valorem', 'specific', 'compound'], required: true })
  cessType: 'ad_valorem' | 'specific' | 'compound';

  /** Applicable for ad_valorem and compound cessType: percentage rate */
  @Prop({ type: Number, min: 0 })
  adValoremRate?: number;

  /** Applicable for specific and compound cessType: paise per unit */
  @Prop({ type: Number, min: 0 })
  specificRatePerUnit?: number;

  /** Unit for specific rate */
  @Prop({ type: String, enum: ['piece', 'kg', 'ml', 'liter', 'tonne'] })
  specificRateUnit?: string;

  @Prop({ type: Date, required: true })
  applicableFrom: Date;

  @Prop({ type: Date })
  applicableTo?: Date;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;
}

export const CessRuleSchema = SchemaFactory.createForClass(CessRule);

// Compound index for efficient date-range and active lookups
CessRuleSchema.index({ hsnCode: 1, isActive: 1, applicableFrom: 1 });

export type CessRuleDocument = HydratedDocument<CessRule>;
