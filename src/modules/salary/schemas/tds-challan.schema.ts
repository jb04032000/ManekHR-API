import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class TdsChallan extends Document {
  @Prop({ type: Types.ObjectId, required: true, ref: 'Workspace' })
  workspaceId: Types.ObjectId;

  @Prop({ required: true, enum: [1, 2, 3, 4] })
  quarter: number;

  @Prop({ required: true })
  financialYear: number;

  @Prop({ required: true })
  month: number;

  @Prop({ required: true })
  year: number;

  @Prop({ required: true, trim: true })
  bsrCode: string;

  @Prop({ trim: true, default: '' })
  bankName: string;

  @Prop({ trim: true, default: '' })
  branchName: string;

  @Prop({ required: true, trim: true })
  challanSerialNo: string;

  @Prop({ required: true })
  depositDate: Date;

  @Prop({ required: true, default: 0 })
  tdsTotalDeposited: number;

  @Prop({ default: 0 })
  interestAmount: number;

  @Prop({ default: 0 })
  feeAmount: number;

  @Prop({ default: 0 })
  totalChallanAmount: number;

  @Prop({ default: '192' })
  section: string;

  @Prop({ default: '200' })
  minorHeadCode: string;

  @Prop({ default: '' })
  remarks: string;

  @Prop({ type: Types.ObjectId })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  updatedBy: Types.ObjectId;
}

export const TdsChallanSchema = SchemaFactory.createForClass(TdsChallan);

TdsChallanSchema.index({ workspaceId: 1, financialYear: 1, quarter: 1 });
TdsChallanSchema.index({ workspaceId: 1, month: 1, year: 1 });
