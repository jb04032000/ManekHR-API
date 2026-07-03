import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * ListDowntimeQueryDto (D-08).
 *
 * Query string for `GET /workspaces/:wsId/machines/:machineId/downtime`.
 * `from` / `to` are workspace-local YYYY-MM-DD calendar dates; the service
 * converts them to a UTC range using the workspace timezone.
 */
export class ListDowntimeQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @IsMongoId()
  machineId?: string;

  @IsOptional()
  @IsMongoId()
  reasonCodeId?: string;

  @IsOptional()
  @IsEnum(['open', 'closed'])
  status?: 'open' | 'closed';

  @IsOptional()
  @IsBooleanString()
  includeDeleted?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}
