import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class GratuityLedger extends Document {
  @Prop({ type: Types.ObjectId, required: true, ref: 'Workspace' })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, ref: 'TeamMember' })
  teamMemberId: Types.ObjectId;

  @Prop({ required: true })
  dateOfJoining: Date;

  @Prop({ default: 0 })
  lastBasicSalary: number;

  @Prop({ default: 0 })
  completedYears: number;

  @Prop({ default: 0 })
  completedMonths: number;

  @Prop({ default: false })
  isEligible: boolean;

  @Prop({ default: 0 })
  gratuityAmount: number;

  @Prop({ required: true })
  lastCalculatedMonth: number;

  @Prop({ required: true })
  lastCalculatedYear: number;

  @Prop({ type: [Object], default: [] })
  monthlyAccruals: Array<{
    month: number;
    year: number;
    basicSalary: number;
    completedYears: number;
    gratuityAmount: number;
  }>;
}

export const GratuityLedgerSchema =
  SchemaFactory.createForClass(GratuityLedger);

GratuityLedgerSchema.index(
  { workspaceId: 1, teamMemberId: 1 },
  { unique: true },
);

GratuityLedgerSchema.index({ workspaceId: 1, isEligible: 1 });
