import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CONNECT_CONTACT_PREFERENCES,
  CONNECT_OPEN_TO_AUDIENCES,
  CONNECT_PROFILE_VISIBILITIES,
} from '../schemas/connect-profile.schema';

/**
 * PATCH body for `/me/connect/profile`. Every field optional — a partial
 * update. `recommendations` is intentionally absent: peers write those, never
 * the profile owner. Date fields accept ISO strings; Mongoose casts on save.
 */

class PortfolioItemDto {
  // Must be an https URL (our-host ownership is enforced server-side in the
  // service via the shared media-ownership guard).
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  image: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  caption?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  machineType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  workType?: string;
}

// One profile video. Mirrors the marketplace `ListingVideoDto`: `url` + optional
// `posterUrl` are both https-only on OUR storage (the service runs them through
// the media-ownership guard); `durationSec` is NOT accepted from the body (the
// service derives it server-side from the owned upload record), so a client
// cannot forge a clip length. The 60s cap is enforced in the UPLOAD probe
// (`connect-profile-video` policy in upload-policies.ts), not here.
class ProfileVideoDto {
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

// One "Services I provide" entry. Mirrors `PortfolioItemDto` (a required string
// plus an optional capped note). Free-typed; no taxonomy this phase.
class ServiceItemDto {
  @IsString()
  @MaxLength(120)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  note?: string;
}

class ExperienceItemDto {
  @IsString()
  @MaxLength(160)
  workshop: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  role?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsMongoId()
  companyPageId?: string;
}

// One self-declared training / education credential. Mirrors `ExperienceItemDto`
// (required name + optional companyPageId link + optional course / date).
// `instituteName` is required; `certificateUrl` must be an https URL on our
// storage.
//
// Institutes Phase 2 student-side fields:
//  - `id`: the stable per-credential handle the client round-trips so the service
//    can reconcile an edit against the prior stored credential (and preserve any
//    institute confirmation). The server assigns one when it is missing / unknown.
//  - `confirmStatus`: CRITICAL guard. The student DTO accepts ONLY `self` /
//    `pending` (@IsIn). `confirmed` / `declined` are rejected by the validator,
//    so a student can never forge a confirmation through this PATCH body. Only the
//    institute-side write path (Feature 2/3) produces those two states.
//  - `shareWithInstitute`: the student's per-credential opt-in to appear on the
//    institute's public alumni / placement surfaces (DPDP, default OFF).
//
// Deliberately NOT present (never student-writable): `confirmedAt`,
// `confirmedByUserId`. Keep the @IsIn list in sync with
// `CONNECT_TRAINING_CONFIRM_STATUSES` in connect-profile.schema.ts (this is the
// student SUBSET: the schema enum carries all four values).
class TrainingItemDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MaxLength(160)
  instituteName: string;

  @IsOptional()
  @IsMongoId()
  companyPageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  course?: string;

  @IsOptional()
  @IsDateString()
  completedAt?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  certificateUrl?: string;

  // Student path is capped at self|pending: confirmed/declined are rejected here,
  // the strongest guard against a student self-confirming a credential.
  @IsOptional()
  @IsIn(['self', 'pending'])
  confirmStatus?: string;

  @IsOptional()
  @IsBoolean()
  shareWithInstitute?: boolean;
}

class RateCardDto {
  /** all amounts in paise */
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyWage?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  pieceRate?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthly?: number;
}

class OpenToDto {
  @IsOptional()
  @IsBoolean()
  work?: boolean;

  @IsOptional()
  @IsBoolean()
  hiring?: boolean;

  @IsOptional()
  @IsBoolean()
  deals?: boolean;

  @IsOptional()
  @IsBoolean()
  customOrders?: boolean;
}

// Rich "open to" card data. ADDITIVE companion to `OpenToDto` (the booleans):
// the boolean gates the card on; this carries the per-intent blurb + audience.
// Mirrors the schema's `ConnectOpenToDetails` + the web profile intent cards.
class OpenToDetailDto {
  @IsOptional() @IsString() @MaxLength(160) detail?: string;
  @IsOptional() @IsIn(CONNECT_OPEN_TO_AUDIENCES) audience?: string;
}
class OpenToDetailsDto {
  @IsOptional() @ValidateNested() @Type(() => OpenToDetailDto) work?: OpenToDetailDto;
  @IsOptional() @ValidateNested() @Type(() => OpenToDetailDto) hiring?: OpenToDetailDto;
  @IsOptional() @ValidateNested() @Type(() => OpenToDetailDto) deals?: OpenToDetailDto;
  @IsOptional() @ValidateNested() @Type(() => OpenToDetailDto) customOrders?: OpenToDetailDto;
}

export class UpdateConnectProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  headline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  banner?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  skills?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  // Structured canonical location (additive; see ConnectProfile schema). Slugs
  // from the shared india-geo dataset + an optional free-text city.
  @IsOptional()
  @IsString()
  @MaxLength(60)
  geoStateSlug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  geoDistrictSlug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  geoCity?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PortfolioItemDto)
  portfolio?: PortfolioItemDto[];

  /**
   * Profile intro video. Capped at ONE (`@ArrayMaxSize(1)`) - a single short
   * clip; the array shape leaves room for "multiple videos" later without a
   * payload change. Each url + posterUrl is ownership-checked by the service;
   * durationSec is server-derived (never trusted from the body). The 60s length
   * cap lives in the upload probe (`connect-profile-video` policy), not here.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProfileVideoDto)
  @ArrayMaxSize(1)
  videos?: ProfileVideoDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExperienceItemDto)
  experience?: ExperienceItemDto[];

  /**
   * Self-declared training / education credentials (Institutes Phase 1). Mirrors
   * the `experience[]` validation; capped at 30 entries (a sane upper bound for a
   * personal credential list). SELF-DECLARED only this phase - no verified field.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrainingItemDto)
  @ArrayMaxSize(30)
  training?: TrainingItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ServiceItemDto)
  services?: ServiceItemDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => RateCardDto)
  rateCard?: RateCardDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OpenToDto)
  openTo?: OpenToDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OpenToDetailsDto)
  openToDetails?: OpenToDetailsDto;

  @IsOptional()
  @IsIn(CONNECT_PROFILE_VISIBILITIES)
  visibility?: string;

  @IsOptional()
  @IsIn(CONNECT_CONTACT_PREFERENCES)
  contactPreference?: string;

  // Broker / dalal self-declaration (Broker badge, Slice 1). Mirrors the other
  // optional booleans (e.g. OpenToDto.work). `brokerSince` is NOT accepted from
  // the body — the service stamps it on the first false→true flip.
  @IsOptional()
  @IsBoolean()
  isBroker?: boolean;
}
