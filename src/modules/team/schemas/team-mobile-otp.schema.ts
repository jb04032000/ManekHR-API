import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ collection: 'team_mobile_otps', timestamps: true })
export class TeamMobileOtp {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId!: Types.ObjectId;

  /** Canonical 91XXXXXXXXXX form. Already normalized by the caller. */
  @Prop({ type: String, required: true, index: true })
  mobile!: string;

  /** bcrypt(plaintextCode, 10). Plaintext NEVER persisted. */
  @Prop({ type: String, required: true })
  codeHash!: string;

  /** TTL index drops expired docs server-side. 5 min after issue. */
  @Prop({ type: Date, required: true, expires: 0 })
  expiresAt!: Date;

  /** Number of wrong-code attempts. After 5, doc is locked (consumed=true). */
  @Prop({ type: Number, default: 0 })
  attempts!: number;

  /** Set when verify succeeds OR after 5 failed attempts. Null otherwise. */
  @Prop({ type: Date, default: null })
  consumedAt?: Date | null;

  /** Actor user id (audit trail). */
  @Prop({ type: Types.ObjectId, required: true })
  requestedBy!: Types.ObjectId;
}

export type TeamMobileOtpDoc = TeamMobileOtp & Document;
export const TeamMobileOtpSchema = SchemaFactory.createForClass(TeamMobileOtp);
TeamMobileOtpSchema.index({ workspaceId: 1, mobile: 1, createdAt: -1 });
