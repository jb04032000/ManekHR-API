import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export const DOCUMENT_TYPES = [
  'aadhaar',
  'pan',
  'passport',
  'driving_license',
  'voter_id',
  'offer_letter',
  'appointment_letter',
  'education',
  'experience',
  'passbook',
  'other',
] as const;

export type TeamMemberDocumentType = (typeof DOCUMENT_TYPES)[number];

@Schema({ timestamps: true })
export class TeamMemberDocument extends Document {
  @Prop({
    type: Types.ObjectId,
    ref: 'TeamMember',
    required: true,
    index: true,
  })
  teamMemberId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: String, enum: DOCUMENT_TYPES, required: true })
  type: TeamMemberDocumentType;

  /** Human-readable label, required when type === 'other'. */
  @Prop({ trim: true, maxlength: 100 })
  label?: string;

  @Prop({ required: true })
  fileUrl: string;

  @Prop()
  fileName?: string;

  @Prop({ type: Number })
  fileSize?: number;

  @Prop()
  mimeType?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  uploadedBy?: Types.ObjectId;
}

export const TeamMemberDocumentSchema =
  SchemaFactory.createForClass(TeamMemberDocument);
