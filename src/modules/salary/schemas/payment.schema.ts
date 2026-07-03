import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { Salary } from './salary.schema';
import { User } from '../../users/schemas/user.schema';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Payment extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: TeamMember | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Salary', required: true })
  salaryId: Salary | Types.ObjectId;

  @Prop({ required: true }) amount: number;
  @Prop({ required: true, type: Date }) paymentDate: Date;

  @Prop({
    enum: ['cash', 'bank_transfer', 'upi', 'cheque', 'split', 'other'],
    required: true,
  })
  paymentMode: string;

  @Prop() referenceNo?: string;
  @Prop() paidBy?: string;

  @Prop() note?: string;

  @Prop({ default: false })
  proofAttached: boolean;

  @Prop() proofUrl?: string; // Legacy field
  @Prop([String]) proofUrls?: string[];
  @Prop() paymentFrom?: string; // Owner bank account ID

  @Prop({
    type: {
      bankName: String,
      accountNumber: String,
      upiRef: String,
    },
    _id: false,
  })
  upiDebitedAccount?: Record<string, any>;

  @Prop({
    type: {
      bankName: String,
      accountNumber: String,
    },
    _id: false,
  })
  bankFromAccount?: Record<string, any>;

  @Prop({
    type: [
      {
        method: {
          type: String,
          enum: ['cash', 'upi', 'bank_transfer', 'cheque', 'split'],
        },
        amount: Number,
        dateTime: String,
        accountNumber: String,
        bankName: String,
        upiRef: String,
        paidBy: String,
        recordedBy: String,
        paymentFrom: String,
        referenceNo: String,
        note: String,
        proofUrls: [String],
      },
    ],
    default: [],
  })
  splitLines?: Record<string, any>[];

  @Prop({ type: Types.ObjectId, ref: 'User' })
  recordedBy: User | Types.ObjectId;

  @Prop({ default: 0 })
  commission: number;

  @Prop()
  commissionNote?: string;

  @Prop({ default: false })
  isAdvance: boolean;

  @Prop({ type: Number })
  advanceForMonth?: number;

  @Prop({ type: Number })
  advanceForYear?: number;

  @Prop({ type: Types.ObjectId, ref: 'SalaryAdjustment' })
  advanceRecoveryAdjustmentId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'AdvanceRecoveryPlan' })
  advanceRecoveryPlanId?: Types.ObjectId;

  /**
   * Set when this advance Payment was disbursed from an approved
   * AdvanceSalaryRequest (worker self-service flow). Links the disbursement
   * back to its request so the disburse step is idempotent (a retried approve
   * reuses the existing active Payment instead of creating a second one) and so
   * the ledger posting can resolve the request directly.
   * Links: salary.service.ts approveAndDisburseAdvanceRequest, advance-salary-request.schema.ts.
   */
  @Prop({ type: Types.ObjectId, ref: 'AdvanceSalaryRequest' })
  advanceRequestId?: Types.ObjectId;

  @Prop({ type: String, enum: ['active', 'reversed'], default: 'active' })
  status: string;

  // ─── Finance ledger tracking (D-07) ────────────────────────────────────────
  @Prop({ type: Boolean, default: false })
  ledgerPosted: boolean;

  @Prop({ type: String })
  ledgerSkipReason?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  reversedBy?: Types.ObjectId;

  @Prop({ type: Date })
  reversedAt?: Date;

  @Prop({ type: String })
  reversalReason?: string;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

// Payment aggregation for salary paginated list
PaymentSchema.index({ salaryId: 1, status: 1 });
PaymentSchema.index({
  workspaceId: 1,
  teamMemberId: 1,
  isAdvance: 1,
  status: 1,
});

// Dashboard payment rollup (launch perf — Workstream F). StatisticsService
// .getDashboardStats (the primary home-load endpoint) runs
// find({ workspaceId, salaryId: { $in: [...] } }) to sum paid amounts for the
// month. Neither index above is a usable prefix for a workspace-scoped salaryId
// lookup ({salaryId,status} is salaryId-led but ignores workspaceId; the 4-key
// one needs teamMemberId next), so the planner fell back to a non-tenant-scoped
// scan on every dashboard load. {workspaceId, salaryId} makes it a tight
// tenant+salary IXSCAN. Additive, no migration.
PaymentSchema.index({ workspaceId: 1, salaryId: 1 });
