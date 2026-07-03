import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class AssetCategory extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, trim: true }) description?: string;
  @Prop({ type: String, required: true }) accountCode: string; // CoA code, e.g. "1501"
  @Prop({ type: String, enum: ['slm', 'wdv'], required: true }) depreciationMethod: string;
  @Prop({ type: Number, required: true }) slmRate: number;     // decimal, e.g. 0.0633
  @Prop({ type: Number, required: true }) wdvRate: number;     // decimal, e.g. 0.181
  @Prop({ type: Number, required: true }) usefulLifeYears: number;
  @Prop({ type: Number, default: 0.05 }) residualValuePct: number;
  @Prop({ type: String }) itActBlock?: string;
  @Prop({ type: Number }) itActRate?: number;
  @Prop({ type: String }) scheduleIIRef?: string;  // e.g. "Sch II Part C 5(i)"
  @Prop({ type: Boolean, default: false }) isNesd: boolean;
  @Prop({ type: Boolean, default: false }) isSystem: boolean;
  @Prop({ type: Boolean, default: false, index: true }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
  @Prop({ type: Types.ObjectId }) createdBy?: Types.ObjectId;
}

export const AssetCategorySchema = SchemaFactory.createForClass(AssetCategory);
AssetCategorySchema.index(
  { firmId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
AssetCategorySchema.index({ workspaceId: 1, firmId: 1, isDeleted: 1 });
