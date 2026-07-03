import {
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SessionPlatform } from '../schemas/session.schema';

export class TerminateAndLoginDto {
  @IsMongoId()
  @IsNotEmpty()
  sessionId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  deviceName: string;

  @IsEnum(['web', 'mobile'])
  platform: SessionPlatform;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ipAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  userAgent?: string;
}

/**
 * Admin override of a user's max concurrent sessions. `null` clears the
 * override and falls back to plan entitlements. Capped at 20 to mirror the
 * admin-panel UI control + prevent runaway override values.
 */
export class UpdateUserSessionLimitDto {
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  sessionLimitOverride: number | null;
}
