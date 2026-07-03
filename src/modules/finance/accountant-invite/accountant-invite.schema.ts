import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class AccountantInvite extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ required: true })
  email: string;

  @Prop({
    type: String,
    enum: ['read_only', 'adjusting_entry'],
    default: 'read_only',
  })
  scopeRole: string;

  @Prop({
    type: [
      {
        module: { type: String },
        access: { type: String, enum: ['none', 'read', 'write'] },
      },
    ],
    default: [],
  })
  modulePermissions: { module: string; access: 'none' | 'read' | 'write' }[];

  @Prop({
    type: String,
    enum: ['pending', 'accepted', 'expired'],
    default: 'pending',
  })
  status: string;

  @Prop({ type: String })
  token?: string;

  @Prop({ type: Date })
  expiresAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  acceptedByUserId?: Types.ObjectId;
}

export const AccountantInviteSchema =
  SchemaFactory.createForClass(AccountantInvite);
AccountantInviteSchema.index({ firmId: 1, email: 1 }, { unique: true });
