import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_SCOPES,
  type FeedbackCategory,
  type FeedbackScope,
} from '../schemas/feedback.schema';

// Auto-captured diagnostics. All optional; bounded lengths so a malicious client
// can't bloat the doc. Instantiated by the global ValidationPipe (transform:true)
// via @Type below. Mirrors RfqLocationDto's nested-DTO pattern.
class FeedbackContextDto {
  @IsOptional() @IsString() @MaxLength(512) path?: string;
  @IsOptional() @IsString() @MaxLength(256) locale?: string;
  @IsOptional() @IsString() @MaxLength(512) userAgent?: string;
  @IsOptional() @IsString() @MaxLength(64) viewport?: string;
  @IsOptional() @IsString() @MaxLength(128) appVersion?: string;
}

// A feedback photo ref MUST be a private ref in OUR feedback bucket. Pinning the
// category prefix blocks a client from smuggling a public URL or a ref into
// another private category. Filenames are timestamp+random (uploads.service), so
// guessing another user's object is impractical. (Not @IsUrl: these are
// `r2-private://` refs, not https URLs.)
const FEEDBACK_REF = /^r2-private:\/\/erp-feedback-media\/[A-Za-z0-9._\-/]+$/;

export class CreateFeedbackDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  module: string;

  // Optional now (mood is not required to send feedback).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsEnum(FEEDBACK_CATEGORIES)
  category?: FeedbackCategory;

  @IsOptional()
  @IsEnum(FEEDBACK_SCOPES)
  scope?: FeedbackScope;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(FEEDBACK_REF, { each: true, message: 'Invalid attachment reference.' })
  @ArrayMaxSize(3)
  attachments?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => FeedbackContextDto)
  context?: FeedbackContextDto;
}
