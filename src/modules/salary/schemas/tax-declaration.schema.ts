import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class TaxDeclaration extends Document {
  @Prop({ type: Types.ObjectId, required: true, ref: 'Workspace' })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, ref: 'TeamMember' })
  teamMemberId: Types.ObjectId;

  @Prop({ required: true })
  financialYear: number;

  @Prop({ enum: ['old', 'new'], default: 'new' })
  taxRegime: 'old' | 'new';

  @Prop({ default: 0 })
  hraExemption: number;

  @Prop({ default: 0 })
  standardDeduction: number;

  @Prop({ default: 0 })
  deduction80C: number;

  @Prop({ default: 0 })
  deduction80D: number;

  @Prop({ default: 0 })
  deduction80G: number;

  @Prop({ default: 0 })
  deduction80CCD1B: number;

  @Prop({ default: 0 })
  deduction80TTA: number;

  @Prop({ default: 0 })
  otherDeductions: number;

  @Prop({ default: 0 })
  previousEmployerGross: number;

  @Prop({ default: 0 })
  previousEmployerTds: number;

  @Prop({ default: 0 })
  tdsDedutedSoFar: number;

  @Prop({ default: '' })
  notes: string;

  // OQ-S6: declaration lock. Karigars self-declare their own 80C/HRA investments
  // until HR locks the declaration at the cutoff. Once locked, a worker self-write
  // is rejected; only HR/Owner (all-scoped) may unlock/edit. Backward-compatible:
  // legacy docs read `isLocked` as undefined → treated as unlocked.
  @Prop({ type: Boolean, default: false })
  isLocked?: boolean;

  @Prop({ type: Types.ObjectId })
  lockedBy?: Types.ObjectId;

  @Prop({ type: Date })
  lockedAt?: Date;

  @Prop({ type: Types.ObjectId })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  updatedBy: Types.ObjectId;
}

export const TaxDeclarationSchema = SchemaFactory.createForClass(TaxDeclaration);

TaxDeclarationSchema.index({ workspaceId: 1, teamMemberId: 1, financialYear: 1 }, { unique: true });
