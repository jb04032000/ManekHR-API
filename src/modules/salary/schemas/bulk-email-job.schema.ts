import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';

export type BulkEmailJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'failed';

@Schema({ timestamps: true })
export class BulkEmailJob extends Document {
  @Prop({
    type: Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ required: true })
  month: number;

  @Prop({ required: true })
  year: number;

  @Prop({
    type: String,
    enum: ['pending', 'processing', 'completed', 'cancelled', 'failed'],
    default: 'pending',
    index: true,
  })
  status: BulkEmailJobStatus;

  @Prop({ default: 0 })
  total: number;

  @Prop({ default: 0 })
  sent: number;

  @Prop({ default: 0 })
  failed: number;

  @Prop({ default: 0 })
  skipped: number;

  @Prop({ default: 0 })
  processed: number;

  @Prop({
    type: [
      {
        salaryId: { type: String, required: true },
        employeeName: { type: String },
        email: { type: String },
        status: {
          type: String,
          enum: ['sent', 'failed', 'skipped'],
          required: true,
        },
        reason: { type: String },
      },
    ],
    default: [],
  })
  details: Array<{
    salaryId: string;
    employeeName: string;
    email: string;
    status: 'sent' | 'failed' | 'skipped';
    reason?: string;
  }>;

  @Prop({ type: String })
  error?: string;
}

export const BulkEmailJobSchema = SchemaFactory.createForClass(BulkEmailJob);

// Auto-expire completed/cancelled/failed jobs after 24 hours
BulkEmailJobSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 86400,
    partialFilterExpression: {
      status: { $in: ['completed', 'cancelled', 'failed'] },
    },
  },
);
