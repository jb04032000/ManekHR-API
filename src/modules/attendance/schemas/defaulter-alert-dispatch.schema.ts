import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * One row per (workspace, evaluated month) the monthly defaulter-alert cron
 * has processed. Existence of a row makes the cron idempotent — a re-run for
 * the same period is skipped.
 */
@Schema({ timestamps: true, collection: 'defaulteralertdispatches' })
export class DefaulterAlertDispatch extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  /** Evaluated period, 'YYYY-MM' (the closed month the cron evaluated). */
  @Prop({ type: String, required: true })
  periodKey: string;

  @Prop({ type: Date, required: true })
  dispatchedAt: Date;

  @Prop({ type: Number, default: 0 })
  defaulterCount: number;

  @Prop({ type: Number, default: 0 })
  recipientCount: number;
}

export const DefaulterAlertDispatchSchema = SchemaFactory.createForClass(DefaulterAlertDispatch);

// One dispatch per workspace per evaluated month.
DefaulterAlertDispatchSchema.index({ workspaceId: 1, periodKey: 1 }, { unique: true });
