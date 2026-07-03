import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { User } from '../../users/schemas/user.schema';

export enum IncrementType {
  FIXED_AMOUNT = 'fixed_amount',
  PERCENTAGE = 'percentage',
}

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class SalaryIncrement extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'TeamMember',
    required: true,
    index: true,
  })
  teamMemberId: TeamMember | Types.ObjectId;

  @Prop({ required: true, min: 1, max: 12 })
  effectiveMonth: number;

  @Prop({ required: true })
  effectiveYear: number;

  @Prop({ required: true, enum: IncrementType })
  type: IncrementType;

  @Prop({ required: true })
  value: number;

  @Prop({ required: true })
  previousSalary: number;

  @Prop({ required: true })
  newSalary: number;

  @Prop()
  note?: string;

  @Prop({ default: false })
  isApplied: boolean;

  @Prop()
  appliedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy: User | Types.ObjectId;
}

export const SalaryIncrementSchema =
  SchemaFactory.createForClass(SalaryIncrement);

SalaryIncrementSchema.index(
  { workspaceId: 1, teamMemberId: 1, effectiveMonth: 1, effectiveYear: 1 },
  { unique: true },
);
