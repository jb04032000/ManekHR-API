import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// A single monthly slab entry
// Example: if salary >= 15001, PT = 200
export class PtSlabEntry {
  @Prop({ required: true })
  minSalary: number;

  @Prop({ type: Number, default: null })
  maxSalary: number | null;

  @Prop({ required: true })
  ptAmount: number;
}

@Schema({ timestamps: true })
export class PtSlabConfig extends Document {
  // Uniqueness is enforced by `PtSlabConfigSchema.index({ state: 1 }, { unique: true })`
  // below — do NOT also put `unique`/`index` here. Declaring it both ways made
  // Mongoose warn "Duplicate schema index on {state:1}". One PT slab config per
  // state stays enforced by that index. Keep this @Prop and that .index() in sync on merge.
  @Prop({ required: true, trim: true })
  state: string;

  @Prop({ type: String, enum: ['monthly', 'annual'], default: 'monthly' })
  frequency: 'monthly' | 'annual';

  @Prop({ type: [Object], default: [] })
  slabs: PtSlabEntry[];

  @Prop({ default: true })
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PtSlabConfigSchema = SchemaFactory.createForClass(PtSlabConfig);

// SINGLE source of the {state:1} unique index — the `state` @Prop above
// intentionally omits `unique` so this is the only declaration (no dup warning).
PtSlabConfigSchema.index({ state: 1 }, { unique: true });
