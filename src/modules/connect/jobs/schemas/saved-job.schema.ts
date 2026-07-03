import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect -- `SavedJob` collection (Phase 5, jobs bookmark). A private
 * bookmark: one row per (user, job). Mirrors the feed `SavedPost` pattern
 * exactly (idempotent save via the unique index; reverse-chronological Saved
 * list by save time). NOT fanned out, no ranking.
 *
 * Links to: jobs.service (saveJob / unsaveJob / listSavedJobs / which jobs a
 * viewer has saved). Web: the bookmark control on the job detail hero + a
 * "Saved" filter on the jobs board.
 */
@Schema({ timestamps: true, collection: 'connect_saved_jobs' })
export class SavedJob extends Document {
  /** The member who saved the job. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** The saved job. */
  @Prop({ type: Types.ObjectId, ref: 'Job', required: true })
  jobId: Types.ObjectId;

  // `createdAt` (save time, the Saved-list sort key) / `updatedAt` from timestamps.
  createdAt?: Date;
  updatedAt?: Date;
}

export type SavedJobDocument = SavedJob & Document;

export const SavedJobSchema = SchemaFactory.createForClass(SavedJob);

// One row per (user, job) -- makes a save idempotent + the un-save lookup exact.
SavedJobSchema.index({ userId: 1, jobId: 1 }, { unique: true });
// The windowed Saved read -- a member's saved jobs, newest-saved first.
SavedJobSchema.index({ userId: 1, createdAt: -1 });
