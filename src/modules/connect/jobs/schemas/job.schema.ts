import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ListingLocation, ListingLocationSchema } from '../../marketplace/schemas/listing.schema';

/**
 * ManekHR Connect -- a Job post (Phase 5).
 *
 * A workshop / company posts work it needs people for; karigars browse the job
 * board and apply (one `JobApplication` per worker per job). Person-centric:
 * `companyUserId` is the owning `User` (never a workspace); a job MAY be posted
 * AS a company page (`companyPageId`) so it carries the page identity, but the
 * user stays the source of truth for ownership + caps. A job is independently
 * boostable via the ads engine (`boostCampaignId`, mirrors `Listing`).
 */
export const JOB_STATUSES = ['open', 'closed', 'filled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** How the wage is expressed -- textile-relevant pay shapes. `hourly` added for
 *  shift / part-time roles. Single source of truth: the DTO derives its enum
 *  from this, the web mirrors it in jobs.types.ts JobWageType + the composer's
 *  WAGE_TYPES, and labels live under i18n `connect.jobs.wageType.*`. */
export const JOB_WAGE_TYPES = ['hourly', 'daily', 'piece', 'monthly'] as const;
export type JobWageType = (typeof JOB_WAGE_TYPES)[number];

/**
 * Coarse occupation presets -- power the board's role strip + role filter and
 * seed the composer's role combobox. The stored `role` is an OPEN string now
 * (custom roles self-register via TagService, same as `category`), so these are
 * the known/canonical values, not an exhaustive enum.
 */
export const JOB_ROLES = ['karigar', 'operator', 'designer', 'supervisor', 'helper'] as const;
export type JobRole = (typeof JOB_ROLES)[number];

/** Engagement shape. Mirrored in web jobs.types.ts JobEmploymentType + the
 *  composer; labels under i18n connect.jobs.employmentTypeOpt.*. */
export const JOB_EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'temporary',
  'apprenticeship',
] as const;
export type JobEmploymentType = (typeof JOB_EMPLOYMENT_TYPES)[number];

/** Working shift. Labels under i18n connect.jobs.shiftOpt.*. */
export const JOB_SHIFTS = ['day', 'night', 'rotational', 'flexible'] as const;
export type JobShift = (typeof JOB_SHIFTS)[number];

/**
 * One job video. Copied verbatim from the marketplace `ListingVideo` shape
 * (url + posterUrl + server-derived durationSec) so the SAME upload pipeline +
 * media-ownership guard drive both surfaces:
 *  - `url`        the uploaded clip (uploads `connect-job-video` category, 60s).
 *  - `posterUrl`  optional client-captured poster frame (a normal image upload);
 *                 lets the detail page paint a still instead of a black box.
 *                 Passes the SAME media-ownership check as `url` (see JobsService).
 *  - `durationSec` the SERVER-parsed clip length (uploads probes it at upload
 *                 time, cap enforced there); copied here at write time, never a
 *                 client claim.
 *
 * Cross-module link: mirrors marketplace/schemas/listing.schema.ts ListingVideo.
 * A job carries at most ONE clip (DTO `@ArrayMaxSize(1)`); the field is an array
 * purely so a future "multiple videos" change needs no schema migration.
 */
@Schema({ _id: false })
export class JobVideo {
  @Prop({ type: String, required: true, trim: true })
  url: string;

  @Prop({ type: String, trim: true })
  posterUrl?: string;

  @Prop({ type: Number, min: 0 })
  durationSec?: number;
}
export const JobVideoSchema = SchemaFactory.createForClass(JobVideo);

@Schema({ timestamps: true, collection: 'connect_jobs' })
export class Job extends Document {
  /** The `User` who posted + owns the job (the audit + permission owner). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  companyUserId: Types.ObjectId;

  /**
   * OPTIONAL company page the job is posted AS (carries the page identity on the
   * board + page Jobs tab). `null` = posted as the person. Ownership of the page
   * is verified at create time; `companyUserId` stays the source of truth.
   */
  @Prop({ type: Types.ObjectId, ref: 'CompanyPage', default: null })
  companyPageId?: Types.ObjectId | null;

  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  title: string;

  @Prop({ type: String, trim: true, maxlength: 5000, default: '' })
  description: string;

  /**
   * Structured "What you'll do" responsibilities -- a clean bullet list rendered
   * as a checklist on the job detail, distinct from the free-text `description`.
   * Each item is a short line. Empty = none (detail hides the section). Mirrored
   * in web jobs.types.ts (Job.responsibilities) + the JobComposer repeatable
   * field; rendered by JobDetailScreen's "What you'll do" card.
   */
  @Prop({ type: [String], default: [] })
  responsibilities: string[];

  /**
   * Trade category -- the board's primary filter (reuses listings' taxonomy).
   * Open string: one of the known LISTING_CATEGORIES slugs OR a custom term. The
   * service normalises it through TagService (same as a listing's `category`) so
   * custom values self-register into the shared ConnectTag pool and stay
   * canonical. Keep in sync with the marketplace listing.category contract.
   */
  @Prop({ type: String, required: true, trim: true, lowercase: true })
  category: string;

  /**
   * Coarse occupation for the role strip. `null` = unspecified. Open string: one
   * of the JOB_ROLES presets OR a custom term, normalised through TagService
   * (shared pool) so custom roles are searchable + suggestable like categories.
   */
  @Prop({ type: String, trim: true, lowercase: true, default: null })
  role?: string | null;

  /** How the wage is expressed. `null` when unspecified / negotiable. */
  @Prop({ type: String, enum: JOB_WAGE_TYPES, default: null })
  wageType?: JobWageType | null;

  /** Wage bounds in rupees (per `wageType`). `null` when open / negotiable. */
  @Prop({ type: Number, min: 0, default: null })
  wageMin?: number | null;

  @Prop({ type: Number, min: 0, default: null })
  wageMax?: number | null;

  /** How many people are needed. Defaults to 1. */
  @Prop({ type: Number, min: 1, default: 1 })
  openings: number;

  @Prop({ type: ListingLocationSchema, default: () => ({}) })
  location: ListingLocation;

  /** Skills the role needs (e.g. Aari, Zardozi) -- card tags + skills filter. */
  @Prop({ type: [String], default: [] })
  skills: string[];

  /** Machine / tool used (e.g. "Schiffli", "Multi-head computerized"). */
  @Prop({ type: String, trim: true, maxlength: 80, default: '' })
  machineType: string;

  /** Engagement shape (full-time / contract / ...). `null` = unspecified. */
  @Prop({ type: String, enum: JOB_EMPLOYMENT_TYPES, default: null })
  employmentType?: JobEmploymentType | null;

  /** Minimum experience in YEARS. `null` = unspecified; 0 = freshers welcome. */
  @Prop({ type: Number, min: 0, max: 50, default: null })
  experienceMin?: number | null;

  /** Working shift (day / night / ...). `null` = unspecified. */
  @Prop({ type: String, enum: JOB_SHIFTS, default: null })
  shift?: JobShift | null;

  /** Free-text working days (e.g. "Mon-Sat"). Empty = unspecified. */
  @Prop({ type: String, trim: true, maxlength: 80, default: '' })
  workingDays: string;

  /** Languages the role needs (e.g. Gujarati, Hindi) -- detail + future filter. */
  @Prop({ type: [String], default: [] })
  languages: string[];

  /** Perks / benefits (e.g. PF & ESI, Meals, Overtime pay) -- detail chips. */
  @Prop({ type: [String], default: [] })
  benefits: string[];

  /**
   * Job video(s). The FIRST media field on a job (jobs had none before this).
   * At most one short clip + optional poster + server-derived durationSec; shown
   * on the job DETAIL page after the description. Each entry's durationSec is
   * server-derived (see JobsService.buildOwnedVideos), never trusted from the
   * body. Empty by default, so every pre-video job is unchanged (additive). Cross-
   * module link: mirrors marketplace Listing.videos exactly. */
  @Prop({ type: [JobVideoSchema], default: [] })
  videos: JobVideo[];

  /** Optional application deadline -- drives "closes in N days" + closing-soon. */
  @Prop({ type: Date, default: null })
  closesAt?: Date | null;

  /** open -> accepting applications; closed -> owner ended it; filled -> hired. */
  @Prop({ type: String, enum: JOB_STATUSES, default: 'open' })
  status: JobStatus;

  /** Denormalized application tally -- shown on the board row. */
  @Prop({ type: Number, default: 0 })
  applicationsCount: number;

  /** Detail-view counter (non-owner views) -- the employer's "N views" stat. */
  @Prop({ type: Number, default: 0 })
  views: number;

  /**
   * The ads `AdCampaign` boosting this job, or `null`. A job boost reuses the
   * shipped ad engine (M2.1 pattern); this back-links the campaign.
   */
  @Prop({ type: Types.ObjectId, ref: 'AdCampaign', default: null })
  boostCampaignId?: Types.ObjectId | null;

  /**
   * Denormalized "this is seeded sample/demo content" marker (Demo Content scope).
   * STAMPED AT CREATE from the owner's `User.isDemo` (mirrors how `Post.authorErpLinked`
   * is denormalized at create in feed.service.ts, and `Listing.isDemo`) — one source
   * the "Sample" badge (web) and the board down-rank (demo-rank.ts) both read. A real
   * user's job is `false`. Cross-module link: buildBoardSort prepends `isDemo` so the
   * board orders real-first; the apply gate (JobsService.applyToJob) also blocks a
   * cross demo<->real application. Watch: legacy rows predate this field — a backfill
   * migration stamps them from their owner.
   */
  @Prop({ type: Boolean, default: false })
  isDemo: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type JobDocument = Job & Document;

export const JobSchema = SchemaFactory.createForClass(Job);

// The board: open jobs, newest first (optionally narrowed by category).
JobSchema.index({ status: 1, createdAt: -1 });
// Default board ordering is real-first then newest (buildBoardSort prepends
// `isDemo`): this index keeps that scan covered so demo down-ranking is free.
JobSchema.index({ status: 1, isDemo: 1, createdAt: -1 });
JobSchema.index({ category: 1, status: 1, createdAt: -1 });
// A person's own posted jobs.
JobSchema.index({ companyUserId: 1, createdAt: -1 });
// A company page's jobs (the page Jobs tab + page-targeted boards).
JobSchema.index({ companyPageId: 1, status: 1, createdAt: -1 });
// The role strip (open jobs of a given occupation, newest first).
JobSchema.index({ status: 1, role: 1, createdAt: -1 });

// Facet/filter support for the board (Phase 1 jobs-board upgrade). Feed the
// $facet counts + the multi-select rail (see jobs.service.boardFacets +
// board-query.helpers.buildBoardFilter). skills is multikey (array field).
// machineType stays UNINDEXED on purpose: it is free-text, uncontrolled
// vocabulary, so the per-facet scan cost is accepted (spec note).
JobSchema.index({ status: 1, 'location.district': 1 });
JobSchema.index({ status: 1, employmentType: 1 });
JobSchema.index({ status: 1, skills: 1 });
