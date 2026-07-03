import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class LateFeeEntry extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) invoiceId: Types.ObjectId;
  @Prop({ type: String, required: true }) invoiceNumber: string;
  @Prop({ type: Types.ObjectId, required: true }) partyId: Types.ObjectId;
  @Prop({ type: Date, required: true }) accrualDate: Date;
  @Prop({ type: Number, required: true }) feePaise: number;
  @Prop({ type: Number, required: true }) originalInvoiceAmountPaise: number;  // base for simple interest
  @Prop({ type: Number, required: true }) daysPastDue: number;
  @Prop({ type: Types.ObjectId }) ledgerEntryId?: Types.ObjectId;  // LedgerEntry created for this fee
  @Prop({ type: String, required: true }) financialYear: string;
}

export const LateFeeEntrySchema = SchemaFactory.createForClass(LateFeeEntry);

// Dedup guard: one accrual per invoice per day
LateFeeEntrySchema.index({ invoiceId: 1, accrualDate: 1 }, { unique: true });
LateFeeEntrySchema.index({ workspaceId: 1, firmId: 1, accrualDate: -1 });
