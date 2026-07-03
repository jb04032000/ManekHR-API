import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

/**
 * Phase 23 (D-02, MACH-P2-03): canonical piece-rate unit enum.
 * Single source of truth for the 4 supported rate units.
 */
export const PIECE_RATE_UNITS = [
  'per_piece',
  'per_thousand_stitches',
  'per_design_completed',
  'blended',
] as const;
export type PieceRateUnit = (typeof PIECE_RATE_UNITS)[number];

@Schema({ _id: false })
export class PerMachineRateOverride {
  @Prop({ type: Types.ObjectId, ref: 'Machine', required: true })
  machineId: Types.ObjectId;

  @Prop({ type: Number, min: 0, required: true })
  rate: number;
}
export const PerMachineRateOverrideSchema =
  SchemaFactory.createForClass(PerMachineRateOverride);

@Schema({ _id: false })
export class PieceRateConfig {
  @Prop({ type: String, enum: PIECE_RATE_UNITS, required: true })
  unit: PieceRateUnit;

  @Prop({ type: Number, min: 0, required: true })
  defaultRate: number;

  @Prop({ type: Number, min: 0, default: 0 })
  basePortion: number;

  @Prop({
    type: [PerMachineRateOverrideSchema],
    default: [],
    validate: {
      validator: (arr: unknown[]) => arr.length <= 50,
      message: 'perMachineOverrides cannot exceed 50 entries',
    },
  })
  perMachineOverrides: PerMachineRateOverride[];

  @Prop({ type: Date, default: () => new Date() })
  effectiveFrom: Date;

  @Prop({ type: Boolean, default: true })
  includeStitchUnit: boolean;
}
export const PieceRateConfigSchema =
  SchemaFactory.createForClass(PieceRateConfig);
