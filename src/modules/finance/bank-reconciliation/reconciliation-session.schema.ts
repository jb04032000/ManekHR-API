import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class ReconciliationSession extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  bankAccountId: Types.ObjectId;

  /** One session per statement */
  @Prop({ type: Types.ObjectId, required: true, index: true })
  bankStatementId: Types.ObjectId;

  /** e.g., 'April 2025 Reconciliation' */
  @Prop({ type: String, required: true })
  sessionName: string;

  @Prop({ type: Date, required: true })
  periodFrom: Date;

  @Prop({ type: Date, required: true })
  periodTo: Date;

  /** e.g., '2024-25' */
  @Prop({ type: String, required: true })
  financialYear: string;

  /** Book (ledger) balance as of periodTo in paise */
  @Prop({ type: Number, required: true, default: 0 })
  bookBalancePaise: number;

  /** Closing balance from BankStatement in paise */
  @Prop({ type: Number, required: true, default: 0 })
  statementClosingBalancePaise: number;

  /** Running difference — should reach 0 when fully reconciled */
  @Prop({ type: Number, required: true, default: 0 })
  differenceExplained: number;

  @Prop({
    type: String,
    required: true,
    enum: ['draft', 'in_progress', 'completed', 'locked'],
    default: 'draft',
  })
  status: string;

  @Prop({ type: Boolean, required: true, default: false })
  autoMatchRun: boolean;

  @Prop({ type: Number, required: true, default: 0 })
  autoMatchedCount: number;

  @Prop({ type: Number, required: true, default: 0 })
  totalMatchedCount: number;

  @Prop({ type: Number, required: true, default: 0 })
  totalUnmatchedCount: number;

  /** Issued cheques not yet presented at bank — in paise */
  @Prop({ type: Number, required: true, default: 0 })
  outstandingChequesPaise: number;

  /** Deposits received but not yet cleared at bank — in paise */
  @Prop({ type: Number, required: true, default: 0 })
  depositsInTransitPaise: number;

  @Prop({ type: Types.ObjectId, required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  completedBy?: Types.ObjectId;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Types.ObjectId })
  lockedBy?: Types.ObjectId;

  @Prop({ type: Date })
  lockedAt?: Date;
}

export const ReconciliationSessionSchema = SchemaFactory.createForClass(ReconciliationSession);

ReconciliationSessionSchema.index({ firmId: 1, bankAccountId: 1, status: 1 });
// Unique: one session per statement (prevents duplicate sessions for same statement)
ReconciliationSessionSchema.index({ firmId: 1, bankStatementId: 1 }, { unique: true });
