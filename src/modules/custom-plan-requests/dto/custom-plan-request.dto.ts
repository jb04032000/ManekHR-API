import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CUSTOM_PLAN_REQUEST_KINDS,
  CUSTOM_PLAN_REQUEST_NOTE_MAX,
  CUSTOM_PLAN_REQUEST_STATUSES,
  type CustomPlanRequestKind,
  type CustomPlanRequestStatus,
} from '../schemas/custom-plan-request.schema';

const STATUS_VALUES = CUSTOM_PLAN_REQUEST_STATUSES as unknown as string[];
const KIND_VALUES = CUSTOM_PLAN_REQUEST_KINDS as unknown as string[];

// Shared lenient phone check: optional leading +, then 7-20 chars of digits/
// space/()/-. Accepts Indian + international formats without over-rejecting; we
// only need a number a human can call back on. Mirrors the FE form pattern.
const MOBILE_PATTERN = /^[+]?\d[\d\s()-]{6,19}$/;

/**
 * Body for POST subscriptions/custom-plan-request (authed user). The global
 * ValidationPipe runs forbidNonWhitelisted, so the web payload must carry EXACTLY
 * these fields (teamMembers, companiesOrFactories?, mobile, note?, product?).
 */
export class CreateCustomPlanRequestDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  teamMembers: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  companiesOrFactories?: number;

  @IsString()
  @Matches(MOBILE_PATTERN, { message: 'Enter a valid mobile number' })
  mobile: string;

  @IsOptional()
  @IsString()
  @MaxLength(CUSTOM_PLAN_REQUEST_NOTE_MAX)
  note?: string;

  @IsOptional()
  @IsIn(['erp', 'connect'])
  product?: string;
}

/**
 * Body for POST subscriptions/custom-plan-request/plan-interest (authed user).
 * Fired when a user clicks Subscribe on a predefined paid plan while online
 * payments are off. planId is required (which plan they want); mobile is required
 * (callback number); teamMembers is OPTIONAL (the popup asks but does not force).
 * planTier/planName are denormalized hints for the admin list.
 */
export class CreatePlanInterestRequestDto {
  @IsMongoId()
  planId: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  planTier?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  planName?: string;

  @IsString()
  @Matches(MOBILE_PATTERN, { message: 'Enter a valid mobile number' })
  mobile: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  teamMembers?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  companiesOrFactories?: number;

  @IsOptional()
  @IsString()
  @MaxLength(CUSTOM_PLAN_REQUEST_NOTE_MAX)
  note?: string;

  @IsOptional()
  @IsIn(['erp', 'connect'])
  product?: string;
}

/** Body for PATCH admin/custom-plan-requests/:id (admin). */
export class AdminUpdateCustomPlanRequestDto {
  @IsOptional()
  @IsIn(STATUS_VALUES)
  status?: CustomPlanRequestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(CUSTOM_PLAN_REQUEST_NOTE_MAX)
  adminNote?: string;
}

/** Query for GET admin/custom-plan-requests (admin). Query params arrive as
 *  strings, so the numeric fields are coerced via @Type(() => Number). */
export class AdminListCustomPlanRequestsQueryDto {
  @IsOptional()
  @IsIn(STATUS_VALUES)
  status?: CustomPlanRequestStatus;

  // Optional kind filter so the admin can segment the shared list into custom vs
  // predefined-plan leads (the UI shows both together with a flag by default).
  @IsOptional()
  @IsIn(KIND_VALUES)
  kind?: CustomPlanRequestKind;

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
  offset?: number;
}
