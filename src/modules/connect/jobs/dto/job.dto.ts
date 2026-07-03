import { Transform, Type } from 'class-transformer';
import { IsGteField } from '../../common/validators/is-gte-field.validator';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { LISTING_CATEGORIES } from '../../marketplace/schemas/listing.schema';
// Resume + apply voice note now land in PRIVATE buckets, so their stored value is
// a `r2-private://` ref (not an https URL). The custom guard accepts a private ref
// OR an https URL; ownership is still enforced in jobs.service via MediaOwnershipService.
import { IsMediaRef } from '../../../uploads/validators/is-media-ref.validator';
import { JOB_EMPLOYMENT_TYPES, JOB_ROLES, JOB_SHIFTS, JOB_WAGE_TYPES } from '../schemas/job.schema';

class JobLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;
}

/**
 * One job video. Copied from create-listing.dto's ListingVideoDto: `url` +
 * optional `posterUrl` are both https-only on OUR storage (the service runs them
 * through the media-ownership guard); `durationSec` is NOT accepted from the body
 * (the service derives it server-side from the owned upload record, and the 60s
 * cap lives in the upload media-probe), so a client cannot forge a clip length.
 * Cross-module link: marketplace/dto/create-listing.dto.ts ListingVideoDto.
 */
export class JobVideoDto {
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  url: string;

  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  posterUrl?: string;
}

/** Post a job (company / workshop owner). */
export class CreateJobDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  /** Structured "What you'll do" lines (checklist on the detail page). Each a
   *  short bullet; empty = none. Mirrors Job.responsibilities. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  responsibilities?: string[];

  /**
   * Trade category. One of the known LISTING_CATEGORIES slugs OR a custom term
   * (max 60). The service normalises it via TagService so custom values
   * self-register and stay canonical (mirrors create-listing.dto's `category`).
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  category!: string;

  @IsOptional()
  @IsIn(JOB_WAGE_TYPES)
  wageType?: (typeof JOB_WAGE_TYPES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  wageMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @IsGteField('wageMin')
  wageMax?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  openings?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => JobLocationDto)
  location?: JobLocationDto;

  /**
   * Coarse occupation -- powers the board's role strip. One of the JOB_ROLES
   * presets OR a custom term (max 60); normalised via TagService like `category`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  role?: string;

  /** Skills the role needs (card tags + the board's skills filter). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  skills?: string[];

  /** Machine / tool used (single tag on the card). */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  machineType?: string;

  /** Engagement shape (full-time / contract / ...). */
  @IsOptional()
  @IsIn(JOB_EMPLOYMENT_TYPES)
  employmentType?: (typeof JOB_EMPLOYMENT_TYPES)[number];

  /** Minimum experience in years (0 = freshers welcome). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  experienceMin?: number;

  /** Working shift (day / night / ...). */
  @IsOptional()
  @IsIn(JOB_SHIFTS)
  shift?: (typeof JOB_SHIFTS)[number];

  /** Free-text working days, e.g. "Mon-Sat". */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  workingDays?: string;

  /** Languages the role needs (chips). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  languages?: string[];

  /** Perks / benefits (chips). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  benefits?: string[];

  /**
   * Job video(s). Capped at ONE (`@ArrayMaxSize(1)`) - a single short clip; the
   * array shape leaves room for "multiple videos" later without a payload change.
   * Each url + posterUrl is ownership-checked by the service; durationSec is
   * server-derived (never trusted from the body). Mirrors create-listing.dto.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JobVideoDto)
  @ArrayMaxSize(1)
  videos?: JobVideoDto[];

  /** Optional application deadline (ISO date) -- drives "closes in N days". */
  @IsOptional()
  @IsDateString()
  closesAt?: string;

  /** OPTIONAL: post this job AS a company page the caller owns. */
  @IsOptional()
  @IsMongoId()
  companyPageId?: string;
}

/**
 * Edit an open job (owner only, enforced in the service). PATCH semantics: every
 * field is optional and only the provided ones change. `companyPageId` is
 * intentionally absent - a job cannot be moved to a different page via edit.
 * category/role are normalised through TagService exactly like create, so an
 * edited custom value still self-registers. Mirrors CreateJobDto's field rules.
 */
export class UpdateJobDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  responsibilities?: string[];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsIn(JOB_WAGE_TYPES)
  wageType?: (typeof JOB_WAGE_TYPES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  wageMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @IsGteField('wageMin')
  wageMax?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  openings?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => JobLocationDto)
  location?: JobLocationDto;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  role?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  skills?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  machineType?: string;

  @IsOptional()
  @IsIn(JOB_EMPLOYMENT_TYPES)
  employmentType?: (typeof JOB_EMPLOYMENT_TYPES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  experienceMin?: number;

  @IsOptional()
  @IsIn(JOB_SHIFTS)
  shift?: (typeof JOB_SHIFTS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  workingDays?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  languages?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  benefits?: string[];

  /**
   * Job video(s). PATCH: an omitted `videos` leaves the existing clip untouched;
   * `videos: []` clears it. Capped at one; each url + posterUrl is ownership-
   * checked (the existing clip is grandfathered in the service) and durationSec is
   * re-stamped server-side. Mirrors update-listing.dto.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JobVideoDto)
  @ArrayMaxSize(1)
  videos?: JobVideoDto[];

  @IsOptional()
  @IsDateString()
  closesAt?: string;
}

/** A karigar's application to a job. */
export class CreateJobApplicationDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  /** Optional voice-note ref (the low-literacy apply path). Private `r2-private://`
   *  ref (or legacy https URL); the service further asserts it is a file on our
   *  storage owned by the applicant. */
  @IsOptional()
  @IsString()
  @IsMediaRef()
  @MaxLength(2000)
  voiceNoteUrl?: string;

  /** Optional resume/CV file ref (private `connect-job-resume` bucket). Private
   *  `r2-private://` ref (or legacy https URL); the service further asserts it is
   *  a file on our storage owned by the applicant. */
  @IsOptional()
  @IsString()
  @IsMediaRef()
  @MaxLength(2000)
  resumeUrl?: string;

  /** Original resume filename (display label). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  resumeName?: string;
}

/**
 * Close an open job, capturing the hiring outcome (the LinkedIn / Indeed / ATS
 * pattern). `filled` true -> the role was filled (a hire happened); false /
 * omitted -> just closed with no hire. Drives the job's terminal status.
 */
export class CloseJobDto {
  @IsOptional()
  @IsBoolean()
  filled?: boolean;
}

/** The company's review decision on an application (shortlist / decline). */
export class SetApplicationStatusDto {
  @IsIn(['shortlisted', 'declined'])
  status!: 'shortlisted' | 'declined';
}

/**
 * Query params for the jobs board (the filter rail + sort + search + paging).
 * Every field is optional; the bare board (no params) keeps prior behaviour.
 */
export class BoardQueryDto {
  @IsOptional()
  @IsIn(LISTING_CATEGORIES)
  category?: (typeof LISTING_CATEGORIES)[number];

  @IsOptional()
  @IsIn(JOB_WAGE_TYPES)
  wageType?: (typeof JOB_WAGE_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsIn(JOB_ROLES)
  role?: (typeof JOB_ROLES)[number];

  @IsOptional()
  @IsIn(JOB_EMPLOYMENT_TYPES)
  employmentType?: (typeof JOB_EMPLOYMENT_TYPES)[number];

  /** Comma-separated skill names. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  skills?: string;

  /**
   * Comma-separated multi-select rail facets. Each plural form SUPERSEDES its
   * singular sibling above when both are sent (see buildBoardFilter): OR within
   * a facet, AND across facets. Kept as loose csv strings (not enums) so the rail
   * can submit several values in one param; the singular params keep working for
   * the job-detail "Similar jobs" deep link.
   */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  districts?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  roles?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  employmentTypes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  machineTypes?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  payMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  payMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  postedWithinDays?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeFilled?: boolean;

  // `pay` kept in the allow-list only for back-compat (old shared URLs) - it now
  // maps to the recent default in buildBoardSort; the UI offers recent / openings
  // / closing. `openings` = most-openings (bulk hiring first).
  @IsOptional()
  @IsIn(['recent', 'openings', 'closing', 'pay'])
  sort?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  skip?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

/**
 * Query params for the board facets endpoint (GET /connect/jobs/board/facets).
 * Same FILTER surface as BoardQueryDto minus sort/limit/skip - facet counts are
 * paging-independent (they answer "how many jobs match if I add this filter").
 * Fields duplicated (not inherited) for clarity; keep in sync with BoardQueryDto's
 * filter fields + buildBoardFilter, which both DTOs feed.
 */
export class BoardFacetsQueryDto {
  @IsOptional()
  @IsIn(LISTING_CATEGORIES)
  category?: (typeof LISTING_CATEGORIES)[number];

  @IsOptional()
  @IsIn(JOB_WAGE_TYPES)
  wageType?: (typeof JOB_WAGE_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsIn(JOB_ROLES)
  role?: (typeof JOB_ROLES)[number];

  @IsOptional()
  @IsIn(JOB_EMPLOYMENT_TYPES)
  employmentType?: (typeof JOB_EMPLOYMENT_TYPES)[number];

  /** Comma-separated skill names. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  skills?: string;

  /** Multi-select csv facets (plural supersedes singular; see buildBoardFilter). */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  districts?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  roles?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  employmentTypes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  machineTypes?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  payMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  payMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  postedWithinDays?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeFilled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
