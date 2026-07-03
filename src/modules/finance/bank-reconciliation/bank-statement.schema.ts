import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class BankStatement extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  bankAccountId: Types.ObjectId;

  // No strict enum — detectedFormat already stores the precise parser key.
  // Removing the enum prevents Mongoose validation failures when new parser
  // variants (e.g. 'icici_v2') are introduced in future waves.
  @Prop({ type: String, required: true })
  bankName: string;

  /** Canonical format key detected by the parser — e.g., 'hdfc', 'icici_v2', 'generic' */
  @Prop({ type: String, required: true })
  detectedFormat: string;

  @Prop({ type: Date, required: true })
  statementDateFrom: Date;

  @Prop({ type: Date, required: true })
  statementDateTo: Date;

  /** e.g., '2024-25' — must match firm FY */
  @Prop({ type: String, required: true })
  financialYear: string;

  /** Opening balance in paise (from statement header) */
  @Prop({ type: Number, required: true, default: 0 })
  openingBalancePaise: number;

  /** Closing balance in paise (from statement header) */
  @Prop({ type: Number, required: true, default: 0 })
  closingBalancePaise: number;

  @Prop({ type: Number, required: true, default: 0 })
  totalRows: number;

  @Prop({ type: Number, required: true, default: 0 })
  matchedRows: number;

  @Prop({ type: Number, required: true, default: 0 })
  unmatchedRows: number;

  @Prop({
    type: String,
    required: true,
    enum: ['imported', 'in_progress', 'reconciled', 'locked'],
    default: 'imported',
  })
  status: string;

  @Prop({ type: Types.ObjectId, required: true })
  importedBy: Types.ObjectId;

  @Prop({ type: Date, required: true })
  importedAt: Date;

  @Prop({ type: Date })
  lockedAt?: Date;

  @Prop({ type: Types.ObjectId })
  lockedBy?: Types.ObjectId;

  @Prop({ type: String, required: true })
  originalFilename: string;
}

export const BankStatementSchema = SchemaFactory.createForClass(BankStatement);

// Unique index: prevents duplicate imports of same statement period for a bank account
BankStatementSchema.index(
  { firmId: 1, bankAccountId: 1, statementDateFrom: 1, statementDateTo: 1 },
  { unique: true },
);
BankStatementSchema.index({ workspaceId: 1, firmId: 1, status: 1 });
