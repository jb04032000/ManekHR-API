import {
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ArrayMaxSize,
} from 'class-validator';
import { REGULARIZATION_REASON_CATEGORIES } from '../schemas/regularization-request.schema';

export class CreateRegularizationDto {
  @IsMongoId()
  memberId: string;

  // YYYY-MM-DD (UTC)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @IsEnum(['PRESENT', 'HALF_DAY', 'LEAVE', 'ABSENT'])
  requestedStatus: 'PRESENT' | 'HALF_DAY' | 'LEAVE' | 'ABSENT';

  @IsOptional()
  @IsISO8601()
  requestedCheckIn?: string;

  @IsOptional()
  @IsISO8601()
  requestedCheckOut?: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsEnum(REGULARIZATION_REASON_CATEGORIES)
  reasonCategory?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10) // hard cap; workspace-configurable cap applied in service
  attachments?: string[];
}

export class DecideRegularizationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListRegularizationsQuery {
  @IsOptional()
  @IsEnum(['pending', 'approved', 'rejected', 'cancelled'])
  status?: 'pending' | 'approved' | 'rejected' | 'cancelled';

  @IsOptional()
  @IsMongoId()
  memberId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/**
 * Settings update DTO. Caps match D-01 RegularizationRequest / Workspace schema:
 * - approvalLevels: DD-3 locks in {1,2,3} → Min(1) Max(3)
 * - maxDaysBack: D-01 schema caps at 90 (default 30 per DD-6) → Min(1) Max(90)
 * - maxAttachmentsPerRequest: schema caps at 10 → Min(0) Max(10)
 * - fallbackApproverUserId: optional User ObjectId
 */
export class UpdateRegularizationConfigDto {
  @IsInt()
  @Min(1)
  @Max(3)
  approvalLevels: number;

  @IsInt()
  @Min(1)
  @Max(90)
  maxDaysBack: number;

  @IsOptional()
  @IsMongoId()
  fallbackApproverUserId?: string | null;

  @IsInt()
  @Min(0)
  @Max(10)
  maxAttachmentsPerRequest: number;
}
