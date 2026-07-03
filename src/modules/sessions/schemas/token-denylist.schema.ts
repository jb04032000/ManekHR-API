import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: false })
export class TokenDenylist extends Document {
  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ required: true })
  expiresAt: Date;
}

export const TokenDenylistSchema = SchemaFactory.createForClass(TokenDenylist);

TokenDenylistSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
