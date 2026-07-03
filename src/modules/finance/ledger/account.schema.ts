import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Account extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  // Explicit { type: String } (not just `required`) so the schema imports cleanly under the
  // integration-test SWC pipeline, which needs an explicit type on every @Prop (no metadata).
  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, required: true })
  code: string;

  @Prop({ type: String })
  group?: string;

  @Prop({ type: String })
  subGroup?: string;

  @Prop({
    type: String,
    enum: ['asset', 'liability', 'capital', 'income', 'expense'],
    required: true,
  })
  type: string;

  @Prop({ type: Boolean, default: false })
  isFromTemplate: boolean;

  @Prop({ type: Boolean, default: false })
  isSystem: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  // Last-set opening balance for display + edit prefill. The authoritative
  // accounting record is a posted 'opening_balance' LedgerEntry (contra 3004
  // Opening Balance Equity) maintained by OpeningBalanceService, so reports read
  // the ledger, not this field. amountPaise is always >= 0; drOrCr carries the side.
  @Prop({
    type: {
      amountPaise: { type: Number },
      drOrCr: { type: String, enum: ['debit', 'credit'] },
      asOfDate: { type: Date },
    },
  })
  openingBalance?: { amountPaise: number; drOrCr: 'debit' | 'credit'; asOfDate: Date };
}

export const AccountSchema = SchemaFactory.createForClass(Account);
AccountSchema.index({ workspaceId: 1, firmId: 1, code: 1 }, { unique: true });
AccountSchema.index({ workspaceId: 1, firmId: 1, isDeleted: 1 });
