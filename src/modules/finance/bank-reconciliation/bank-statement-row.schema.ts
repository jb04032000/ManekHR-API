import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class BankStatementRow extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  bankStatementId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  bankAccountId: Types.ObjectId;

  /** 0-based row index for stable ordering */
  @Prop({ type: Number, required: true })
  rowIndex: number;

  @Prop({ type: Date, required: true, index: true })
  txnDate: Date;

  @Prop({ type: Date })
  valueDate?: Date;

  /** Raw narration text from statement */
  @Prop({ type: String, required: true, default: '' })
  narration: string;

  /** Normalised narration for matching (stripped prefixes, lowercased) */
  @Prop({ type: String, required: true, default: '' })
  narrationNorm: string;

  /** Raw cheque / UTR / reference number from statement */
  @Prop({ type: String })
  refNumber?: string;

  /** Normalised reference number for matching */
  @Prop({ type: String })
  refNumberNorm?: string;

  /** Debit amount in paise (0 for credit transactions) */
  @Prop({ type: Number, required: true, default: 0 })
  debitPaise: number;

  /** Credit amount in paise (0 for debit transactions) */
  @Prop({ type: Number, required: true, default: 0 })
  creditPaise: number;

  /** Signed amount in paise: credit positive, debit negative */
  @Prop({ type: Number, required: true })
  amountPaise: number;

  /** Running closing balance if present in CSV */
  @Prop({ type: Number })
  closingBalancePaise?: number;

  @Prop({
    type: String,
    required: true,
    enum: ['unmatched', 'matched', 'excluded', 'disputed', 'new_voucher'],
    default: 'unmatched',
  })
  status: string;

  /**
   * Array of matched LedgerEntry IDs.
   * Supports many-to-many bulk match (RESEARCH §5 Pattern Bulk Many-to-Many).
   */
  @Prop({ type: [{ type: Types.ObjectId }], required: true, default: [] })
  matchedLedgerEntryIds: Types.ObjectId[];

  /** Source voucher IDs from matched LedgerEntries */
  @Prop({ type: [{ type: Types.ObjectId }], required: true, default: [] })
  matchedVoucherIds: Types.ObjectId[];

  /** Source voucher types from matched LedgerEntries */
  @Prop({ type: [{ type: String }], required: true, default: [] })
  matchedVoucherTypes: string[];

  /** Confidence score 0-100 from the matching engine */
  @Prop({ type: Number })
  matchConfidence?: number;

  @Prop({
    type: String,
    enum: ['exact', 'fuzzy_amount_date', 'fuzzy_narration', 'manual', 'auto', 'reversal_pair', 'bulk'],
  })
  matchType?: string;

  /** User who performed manual match */
  @Prop({ type: Types.ObjectId })
  matchedBy?: Types.ObjectId;

  @Prop({ type: Date })
  matchedAt?: Date;

  /** Reason for disputed/excluded status */
  @Prop({ type: String })
  excludeReason?: string;

  /**
   * For reversal_pair rows: the _id of the partner row in this pair.
   * Stored at match time so unmatch can find the precise partner even when
   * multiple reversal pairs with the same amount exist in the same statement.
   */
  @Prop({ type: Types.ObjectId })
  reversalPairRowId?: Types.ObjectId;

  /** Voucher type if row resulted in a new voucher creation (e.g., 'expense', 'journal') */
  @Prop({ type: String })
  newVoucherType?: string;

  /**
   * Top 3 match candidates for UI display.
   * Stored to avoid re-running match engine on every row render.
   */
  @Prop({
    type: [
      {
        ledgerEntryId: { type: Types.ObjectId, required: true },
        confidence: { type: Number, required: true },
        matchType: { type: String, required: true },
      },
    ],
    required: true,
    default: [],
  })
  topSuggestions: { ledgerEntryId: Types.ObjectId; confidence: number; matchType: string }[];
}

export const BankStatementRowSchema = SchemaFactory.createForClass(BankStatementRow);

// Unique index: stable row ordering within a statement
BankStatementRowSchema.index({ bankStatementId: 1, rowIndex: 1 }, { unique: true });
BankStatementRowSchema.index({ bankStatementId: 1, status: 1 });
BankStatementRowSchema.index({ workspaceId: 1, firmId: 1, bankAccountId: 1, txnDate: -1 });
