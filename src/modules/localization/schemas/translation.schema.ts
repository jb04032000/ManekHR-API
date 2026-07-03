import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class Translation extends Document {
  @Prop({ type: String, required: true }) languageCode: string; // 'en', 'gu', 'gu-en', 'hi-en'
  @Prop({ type: String, required: true }) namespace: string; // 'common', 'auth', 'attendance'
  @Prop({ type: String, required: true }) key: string; // 'save', 'login', 'errors.required'
  @Prop({ type: String, required: true }) value: string; // translated string value
  @Prop({ type: String, default: null }) updatedBy: string | null; // admin userId string
  @Prop({ type: [String], default: ['mobile', 'web'] }) platforms: string[];
  @Prop({ type: String, default: null }) description: string | null;
  @Prop({ type: String, default: null }) screen: string | null;
  @Prop({ type: String, default: null }) feature: string | null;
  @Prop({ type: String, default: null }) componentRef: string | null;
  @Prop({ type: [String], default: [] }) tags: string[];
}

export const TranslationSchema = SchemaFactory.createForClass(Translation);

// Compound unique index: { languageCode, namespace, key }
TranslationSchema.index({ languageCode: 1, namespace: 1, key: 1 }, { unique: true });
TranslationSchema.index({ languageCode: 1 });
TranslationSchema.index({ languageCode: 1, platforms: 1 });
TranslationSchema.index({ screen: 1 });
TranslationSchema.index({ feature: 1 });
TranslationSchema.index({ tags: 1 });
TranslationSchema.index({ screen: 1, feature: 1 });
