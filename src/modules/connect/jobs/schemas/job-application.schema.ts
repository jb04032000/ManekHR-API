import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect -- a karigar's application to a Job (Phase 5).
 *
 * The application IS the applicant's Connect profile plus an OPTIONAL short
 * message + an OPTIONAL voice note (low-literacy friendly -- no resume file).
 * One application per worker per job (unique index); the worker edits or
 * withdraws rather than stacking. The company reviews applications on the job
 * detail and shortlists / accepts / declines. Person-centric (`applicantUserId`).
 */
export const APPLICATION_STATUSES = [
  'applied',
  'shortlisted',
  'accepted',
  'declined',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

@Schema({ timestamps: true, collection: 'connect_job_applications' })
export class JobApplication extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Job', required: true })
  jobId: Types.ObjectId;

  /** The karigar applying. Person-centric. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  applicantUserId: Types.ObjectId;

  /** Optional short cover message. */
  @Prop({ type: String, trim: true, maxlength: 2000, default: '' })
  message: string;

  /** Optional voice-note URL (uploads `connect-*`) -- the low-literacy path. */
  @Prop({ type: String, trim: true, default: null })
  voiceNoteUrl?: string | null;

  /** Optional resume/CV file URL (uploads `documents`: one PDF/DOC/DOCX <=10MB).
   *  null = none. The doc path; voice note remains the low-literacy alternative. */
  @Prop({ type: String, trim: true, default: null })
  resumeUrl?: string | null;

  /** Original resume filename, for a friendly label in the review list. */
  @Prop({ type: String, trim: true, maxlength: 200, default: '' })
  resumeName: string;

  /** applied -> live; shortlisted/accepted/declined -> company review; withdrawn -> applicant pulled it. */
  @Prop({ type: String, enum: APPLICATION_STATUSES, default: 'applied' })
  status: ApplicationStatus;

  /** When the EMPLOYER first opened this application (set in listApplicationsForMyJob).
   *  Drives the applicant-facing "Viewed" signal: status 'applied' + viewedAt set =>
   *  the employer has seen it but not yet shortlisted/declined. Null = not yet seen.
   *  Real signal only - never inferred. Surfaced via listMyApplications. */
  @Prop({ type: Date, default: null })
  viewedAt?: Date | null;

  /**
   * Denormalized "this is a seeded sample/demo application" marker (Demo Content
   * scope). STAMPED AT APPLY from the applicant's `User.isDemo` (mirrors `Job.isDemo`
   * / `Listing.isDemo`). Lets the employer's applicant list flag a sample applicant,
   * and pairs with the apply-time gate that blocks cross demo<->real applications.
   * A real applicant is `false`. Watch: legacy rows predate this field — a backfill
   * migration stamps them from their applicant.
   */
  @Prop({ type: Boolean, default: false })
  isDemo: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type JobApplicationDocument = JobApplication & Document;

export const JobApplicationSchema = SchemaFactory.createForClass(JobApplication);

// One application per worker per job (the worker edits/withdraws instead of stacking).
JobApplicationSchema.index({ jobId: 1, applicantUserId: 1 }, { unique: true });
// A worker's own applications, newest first.
JobApplicationSchema.index({ applicantUserId: 1, createdAt: -1 });
