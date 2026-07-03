import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class DepreciationRun extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: String, required: true }) runMonth: string;       // YYYY-MM
  @Prop({ type: String, enum: ['monthly', 'quarterly', 'manual'], required: true }) runType: string;
  @Prop({ type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' }) status: string;
  @Prop({ type: Number, default: 0 }) assetsProcessed: number;
  @Prop({ type: Number, default: 0 }) assetsSkipped: number;
  @Prop({ type: Number, default: 0 }) totalDepreciationPaise: number;
  @Prop({ type: [Types.ObjectId], default: [] }) ledgerEntryIds: Types.ObjectId[];
  @Prop({ type: Date }) runAt?: Date;
  @Prop({ type: String }) runBy?: string;     // 'cron' or userId string
  @Prop({ type: String }) errorMessage?: string;
}

export const DepreciationRunSchema = SchemaFactory.createForClass(DepreciationRun);
DepreciationRunSchema.index({ firmId: 1, runMonth: 1, runType: 1 }, { unique: true });
DepreciationRunSchema.index({ workspaceId: 1, firmId: 1, status: 1 });
