import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class TdsTracker extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) vendorPartyId: Types.ObjectId;
  @Prop({
    type: String,
    enum: ['sec_194c', 'sec_194h', 'sec_194j', 'sec_194q'],
    required: true,
  }) section: string;
  @Prop({ type: String, required: true }) financialYear: string;        // e.g., "2025-26"
  @Prop({ type: Number, default: 0 }) cumulativePaise: number;          // atomic $inc on each PB/PaymentOut
  @Prop({ type: Number, default: 0 }) totalTdsDeductedPaise: number;
}

export const TdsTrackerSchema = SchemaFactory.createForClass(TdsTracker);
TdsTrackerSchema.index(
  { workspaceId: 1, firmId: 1, vendorPartyId: 1, section: 1, financialYear: 1 },
  { unique: true },
);
