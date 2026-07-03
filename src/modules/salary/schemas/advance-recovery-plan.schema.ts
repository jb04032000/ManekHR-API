import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { Payment } from './payment.schema';
import { SalaryAdjustment } from './salary-adjustment.schema';
import { User } from '../../users/schemas/user.schema';

export const ADVANCE_PLAN_STATUSES = ['active', 'paused', 'completed', 'reversed'] as const;

export type AdvancePlanStatus = (typeof ADVANCE_PLAN_STATUSES)[number];

export const INSTALLMENT_STATUSES = ['scheduled', 'applied', 'reversed', 'carried'] as const;

export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

export const CLOSURE_TYPES = ['completed', 'early_payoff', 'reversed'] as const;

export type ClosureType = (typeof CLOSURE_TYPES)[number];

@Schema({ timestamps: true })
export class AdvanceRecoveryPlan extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: TeamMember | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Payment', required: true })
  sourcePaymentId: Payment | Types.ObjectId;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({ required: true })
  installmentAmount: number;

  @Prop({ required: true })
  installmentCount: number;

  @Prop({ required: true })
  startMonth: number;

  @Prop({ required: true })
  startYear: number;

  @Prop({ type: String, enum: ADVANCE_PLAN_STATUSES, default: 'active' })
  status: AdvancePlanStatus;

  @Prop({ type: Number, default: 0 })
  recoveredAmount: number;

  @Prop({ required: true })
  remainingAmount: number;

  @Prop({
    type: [
      {
        index: { type: Number },
        month: { type: Number },
        year: { type: Number },
        plannedAmount: { type: Number },
        appliedAmount: { type: Number, default: 0 },
        adjustmentId: { type: Types.ObjectId, ref: 'SalaryAdjustment' },
        status: {
          type: String,
          enum: INSTALLMENT_STATUSES,
          default: 'scheduled',
        },
        _id: false,
      },
    ],
    default: [],
  })
  installments: Array<{
    index: number;
    month: number;
    year: number;
    plannedAmount: number;
    appliedAmount: number;
    adjustmentId?: SalaryAdjustment | Types.ObjectId;
    status: InstallmentStatus;
  }>;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'SalaryAdjustment' }], default: [] })
  linkedAdjustmentIds: Types.ObjectId[];

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: User | Types.ObjectId;

  // Closure fields
  @Prop({ type: Types.ObjectId, ref: 'User' })
  closedBy?: Types.ObjectId;

  @Prop({ type: Date })
  closedAt?: Date;

  @Prop({ type: String, enum: CLOSURE_TYPES })
  closureType?: ClosureType;

  @Prop({ type: String })
  closureReason?: string;

  // Pause fields
  @Prop({ type: Types.ObjectId, ref: 'User' })
  pausedBy?: Types.ObjectId;

  @Prop({ type: Date })
  pausedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const AdvanceRecoveryPlanSchema = SchemaFactory.createForClass(AdvanceRecoveryPlan);

export type AdvanceRecoveryPlanDocument = AdvanceRecoveryPlan & Document;

AdvanceRecoveryPlanSchema.index({ workspaceId: 1, teamMemberId: 1, status: 1 });
AdvanceRecoveryPlanSchema.index({ workspaceId: 1, sourcePaymentId: 1 });
// One active plan per advance payment
AdvanceRecoveryPlanSchema.index(
  { sourcePaymentId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
