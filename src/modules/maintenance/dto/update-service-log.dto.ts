import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * UpdateServiceLogDto — D-15 frozen-fields rule enforced at the validator
 * layer.
 *
 * ONLY `notes` and `costPaise` are editable, and only within the 7-day window
 * checked by ServiceLogsService.update (24-06). All other fields
 * (`partsReplaced`, `checklistTicked`, `servicedAt`, `serviceEndAt`,
 * `technicianId`, `scheduleId`) are FROZEN immediately on create — any
 * attempt surfaces `SERVICE_LOG_FROZEN_FIELD` 400.
 *
 * Whitelist-only with `forbidNonWhitelisted: true` global ValidationPipe
 * config means unknown field names in the payload are rejected outright,
 * giving us validator-layer enforcement of D-15 without per-field service
 * logic for every frozen attribute.
 */
export class UpdateServiceLogDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  costPaise?: number;
}
