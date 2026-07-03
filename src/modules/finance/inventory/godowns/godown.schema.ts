import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type GodownDocument = HydratedDocument<Godown>;

@Schema({ timestamps: true })
export class Godown {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 100 })
  name: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code: string;

  @Prop({ type: String, maxlength: 500 })
  address?: string;

  @Prop({ type: String, maxlength: 100 })
  contactPerson?: string;

  @Prop({ type: String, maxlength: 20 })
  contactPhone?: string;

  @Prop({ type: Boolean, default: false })
  isDefault: boolean;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const GodownSchema = SchemaFactory.createForClass(Godown);

// Compound unique index: code must be unique per firm (excluding soft-deleted)
GodownSchema.index(
  { workspaceId: 1, firmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Compound index: efficient lookup of the default godown per firm
GodownSchema.index({ workspaceId: 1, firmId: 1, isDefault: 1 });
