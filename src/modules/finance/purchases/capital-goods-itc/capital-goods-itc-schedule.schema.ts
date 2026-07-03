import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class CapitalGoodsItcSchedule extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) sourceBillId: Types.ObjectId;
  @Prop({ type: String, required: true }) sourceBillNumber: string;
  @Prop({ type: Number, required: true }) sourceLineNo: number;        // 0-based index in PB.lineItems
  @Prop({ type: String, required: true }) itemName: string;            // snapshot
  @Prop({ type: Number, required: true }) totalItcPaise: number;
  @Prop({ type: Number, default: 60 }) monthsTotal: number;
  @Prop({ type: Number, default: 0 }) monthsAmortised: number;
  @Prop({ type: Number, required: true }) monthlyAmountPaise: number;  // Math.round(totalItcPaise / 60)
  @Prop({ type: String, required: true }) startMonth: string;          // YYYY-MM
  @Prop({ type: String, required: true, index: true }) nextAmortisationMonth: string;  // YYYY-MM cursor
  @Prop({
    type: String,
    enum: ['amortising', 'completed', 'reversed'],
    default: 'amortising',
  }) status: string;
  @Prop({ type: String, required: true }) financialYear: string;
  @Prop({
    type: String,
    enum: ['cgst_sgst', 'igst'],
    required: true,
  }) itcSplit: string;                                                 // determines release accounts
  @Prop({ type: Number, default: 0 }) cgstReleasedPaise: number;
  @Prop({ type: Number, default: 0 }) sgstReleasedPaise: number;
  @Prop({ type: Number, default: 0 }) igstReleasedPaise: number;
  @Prop({ type: Number, required: true }) cgstTotalPaise: number;
  @Prop({ type: Number, required: true }) sgstTotalPaise: number;
  @Prop({ type: Number, required: true }) igstTotalPaise: number;
}

export const CapitalGoodsItcScheduleSchema = SchemaFactory.createForClass(CapitalGoodsItcSchedule);
CapitalGoodsItcScheduleSchema.index({ workspaceId: 1, firmId: 1, status: 1, nextAmortisationMonth: 1 });
CapitalGoodsItcScheduleSchema.index({ sourceBillId: 1, sourceLineNo: 1 }, { unique: true });
