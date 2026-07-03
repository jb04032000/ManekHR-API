import { IsOptional, IsString, IsInt, Min, Max, IsISO8601 } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Query filters for the workspace-wide team activity feed
 * (`GET /workspaces/:workspaceId/team/activity`). All optional; the service
 * clamps `limit` to [1, 100] and defaults page=1, limit=25.
 */
export class TeamActivityQueryDto {
  /** Filter to a single actor (User id). */
  @IsOptional()
  @IsString()
  actorId?: string;

  /** Filter to a single audit action string (e.g. `team.member_created`). */
  @IsOptional()
  @IsString()
  action?: string;

  /** Inclusive lower bound on event time (ISO 8601). */
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  /** Inclusive upper bound on event time (ISO 8601). */
  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
