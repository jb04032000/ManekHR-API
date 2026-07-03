import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

// ─── JournalVoucherLine sub-document ─────────────────────────────────────────

export interface JournalVoucherLine {
  accountId: Types.ObjectId;
  accountCode: string;
  accountName: string;
  /** 0 if this is a credit line */
  debitPaise: number;
  /** 0 if this is a debit line */
  creditPaise: number;
  partyId?: Types.ObjectId;
  costCentre?: string;
}

// ─── JournalVoucher document ──────────────────────────────────────────────────

@Schema({ timestamps: true })
export class JournalVoucher extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  /**
   * 'journal' = free-form double-entry
   * 'contra' = cash ↔ bank transfers only (VoucherSeries enum now includes 'contra')
   */
  @Prop({
    type: String,
    enum: ['journal', 'contra'],
    required: true,
  })
  voucherType: string;

  @Prop({ type: String })
  voucherNumber?: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({ type: String, required: true })
  financialYear: string;

  @Prop({
    type: String,
    enum: ['draft', 'posted', 'cancelled'],
    default: 'draft',
  })
  state: string;

  /**
   * MANDATORY narration (Pitfall 6: journal entries without narration trigger audit queries).
   * minlength: 5 enforced at schema level; Wave 2 DTO also enforces via class-validator.
   */
  @Prop({ required: true, minlength: 5 })
  narration: string;

  @Prop({
    type: [
      {
        accountId: { type: Types.ObjectId, required: true },
        accountCode: { type: String, required: true },
        accountName: { type: String, required: true },
        debitPaise: { type: Number, required: true, default: 0 },
        creditPaise: { type: Number, required: true, default: 0 },
        partyId: { type: Types.ObjectId },
        costCentre: { type: String },
      },
    ],
    default: [],
  })
  lines: JournalVoucherLine[];

  /** Sum of all debit line amounts — must equal totalCreditPaise at post time */
  @Prop({ type: Number, default: 0 })
  totalDebitPaise: number;

  /** Sum of all credit line amounts — must equal totalDebitPaise at post time */
  @Prop({ type: Number, default: 0 })
  totalCreditPaise: number;

  @Prop({ type: String })
  reference?: string;

  @Prop({ type: Boolean, default: false })
  isRecurring: boolean;

  @Prop({
    type: {
      frequency: { type: String, enum: ['monthly', 'quarterly'] },
      nextRunDate: { type: Date },
      endDate: { type: Date },
    },
  })
  recurringConfig?: {
    frequency: 'monthly' | 'quarterly';
    nextRunDate: Date;
    endDate?: Date;
  };

  @Prop({ type: Types.ObjectId, required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Array, default: [] })
  auditLog: any[];
}

export const JournalVoucherSchema = SchemaFactory.createForClass(JournalVoucher);

JournalVoucherSchema.index({ firmId: 1, voucherDate: -1 });
JournalVoucherSchema.index({ firmId: 1, state: 1 });
