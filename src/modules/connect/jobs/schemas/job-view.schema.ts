import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect -- a single record that "user X has seen job Y" (Phase 5,
 * view-count fix). One row per (job, viewer) via the unique index, so the
 * employer's `Job.views` stat counts DISTINCT non-owner viewers, not raw page
 * hits. Without this, every refresh / back-nav / router.refresh re-ran
 * `$inc: { views: 1 }` and inflated the number (one account showed 15 views).
 *
 * Links to: jobs.service.getJob (writes the row, then increments Job.views only
 * when the insert is new). The owner is never recorded (their own views do not
 * count); logged-out viewers are not recorded either (no viewerId to dedup on).
 */
@Schema({ timestamps: true, collection: 'connect_job_views' })
export class JobView extends Document {
  /** The job that was viewed. */
  @Prop({ type: Types.ObjectId, ref: 'Job', required: true })
  jobId: Types.ObjectId;

  /** The logged-in non-owner who viewed it. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  viewerId: Types.ObjectId;

  // `createdAt` (first-view time) / `updatedAt` from `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type JobViewDocument = JobView & Document;

export const JobViewSchema = SchemaFactory.createForClass(JobView);

// One row per (job, viewer) -- makes view counting idempotent: a viewer who
// re-opens the job never re-increments. This unique index is the dedup backstop.
JobViewSchema.index({ jobId: 1, viewerId: 1 }, { unique: true });
