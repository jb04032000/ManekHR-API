import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class BrokerCommissionEntry extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) invoiceId: Types.ObjectId;
  @Prop({ type: String, required: true }) invoiceNumber: string;
  @Prop({ type: Types.ObjectId, required: true }) receiptId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) brokerPartyId: Types.ObjectId;
  @Prop({ type: Number, required: true }) commissionPaise: number;
  @Prop({ type: Number, required: true }) commissionRatePct: number;
  @Prop({ type: Number, required: true }) allocatedPaise: number;  // payment amount this commission is on
  @Prop({ type: Boolean, default: false }) tdsApplicable: boolean;  // F-04 posts the TDS deduction
  @Prop({ type: Types.ObjectId }) ledgerEntryId?: Types.ObjectId;
  @Prop({ type: String, required: true }) financialYear: string;
}

export const BrokerCommissionEntrySchema = SchemaFactory.createForClass(BrokerCommissionEntry);

BrokerCommissionEntrySchema.index({ workspaceId: 1, firmId: 1, brokerPartyId: 1, financialYear: 1 });
BrokerCommissionEntrySchema.index({ receiptId: 1 });
