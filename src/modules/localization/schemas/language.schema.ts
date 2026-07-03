import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class Language extends Document {
  @Prop({ type: String, required: true, unique: true }) code: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, required: true }) nativeName: string;
  @Prop({ type: String }) example?: string;
  @Prop({ type: Boolean, default: false }) isDefault: boolean;
  @Prop({ type: Boolean, default: true }) isActive: boolean;
  @Prop({ type: Number, default: 1 }) bundleVersion: number;
  @Prop({ type: String, enum: ['ltr', 'rtl'], default: 'ltr' }) direction: 'ltr' | 'rtl';
  createdAt: Date;
  updatedAt: Date;
}

export const LanguageSchema = SchemaFactory.createForClass(Language);
