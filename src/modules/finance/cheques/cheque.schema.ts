import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Cheque extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['issued', 'received'],
    required: true,
  })
  chequeType: string;

  @Prop({ required: true })
  chequeNumber: string;

  /** Actual date printed on the cheque — critical for PDC detection */
  @Prop({ type: Date, required: true })
  chequeDate: Date;

  /**
   * true when chequeDate > today at time of entry.
   * PDC received: post to 1009 PDC Receivable (not bank).
   * PDC issued: post to 2015 PDC Payable (not bank).
   */
  @Prop({ type: Boolean, default: false })
  isPostDated: boolean;

  @Prop({ type: Types.ObjectId, required: true })
  bankAccountId: Types.ObjectId;

  @Prop({ required: true })
  bankAccountName: string;

  /** Amount in paise — T-F06W1-04: Wave 2 DTO validates Math.floor === amount and amount > 0 */
  @Prop({ type: Number, required: true })
  amount: number;

  @Prop({ type: Types.ObjectId })
  partyId?: Types.ObjectId;

  @Prop({ type: String })
  partyName?: string;

  @Prop({ type: Types.ObjectId })
  paymentVoucherId?: Types.ObjectId;

  @Prop({ type: String })
  paymentVoucherNumber?: string;

  @Prop({
    type: String,
    enum: ['pending_maturity', 'in_transit', 'cleared', 'bounced', 'stopped', 'void'],
    default: 'pending_maturity',
  })
  status: string;

  @Prop({ type: Date })
  depositDate?: Date;

  @Prop({ type: Date })
  presentationDate?: Date;

  @Prop({ type: Date })
  clearingDate?: Date;

  @Prop({ type: Date })
  bounceDate?: Date;

  @Prop({ type: String })
  bounceReason?: string;

  @Prop({ type: Number })
  bounceChargesPaise?: number;

  @Prop({ type: Number })
  bounceChargesRecoveredPaise?: number;

  @Prop({ type: Date })
  stopPaymentDate?: Date;

  @Prop({ type: String })
  stopPaymentNarration?: string;

  /** All LedgerEntries created across this cheque's lifecycle */
  @Prop({ type: [Types.ObjectId], default: [] })
  ledgerEntryIds: Types.ObjectId[];

  @Prop({ type: String })
  narration?: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;
}

export const ChequeSchema = SchemaFactory.createForClass(Cheque);

ChequeSchema.index({ firmId: 1, status: 1 });
ChequeSchema.index({ firmId: 1, chequeDate: 1 });
ChequeSchema.index({ firmId: 1, chequeType: 1, status: 1 });

/** No duplicate cheque numbers per bank account per type */
ChequeSchema.index(
  { firmId: 1, bankAccountId: 1, chequeNumber: 1, chequeType: 1 },
  { unique: true },
);
