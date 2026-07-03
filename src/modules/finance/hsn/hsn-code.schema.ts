import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// Global (not tenant-scoped) HSN/SAC reference directory powering the plain-language
// code finder (D18). National reference data, so one shared collection seeded once by
// HsnService; the D15 admin tax-rule work later extends this (effective-dated rates).
// Cross-link: hsn.service.ts (seed + cached search), hsn-seeds.ts (textile master).
@Schema({ timestamps: true })
export class HsnCode extends Document {
  @Prop({ required: true, unique: true, index: true })
  code: string; // HSN (4-8 digit goods) or SAC (6 digit services)

  @Prop({ type: String, enum: ['hsn', 'sac'], required: true })
  type: string;

  @Prop({ required: true })
  description: string;

  // Plain-language search terms (en + gu): saree, grey fabric, taka, than, dyeing, dalali...
  @Prop({ type: [String], default: [] })
  synonyms: string[];

  // Current common GST rate (%); per-piece value thresholds (apparel) are noted in the
  // description, and per-SKU override (D5) still applies on the line.
  @Prop({ required: true })
  gstRate: number;

  @Prop({ type: String })
  chapter?: string;
}

export const HsnCodeSchema = SchemaFactory.createForClass(HsnCode);
