import { IsString, IsNotEmpty, IsOptional, IsIn, IsMongoId, MaxLength } from 'class-validator';
import { CONTENT_REPORT_REASONS, CONTENT_REPORT_TARGET_TYPES } from '../content-reports.constants';

/**
 * Member-submitted report of public content. The reporter is derived from the
 * JWT (req.user.sub), never the body. `snapshot`/`targetUrl` are captured by the
 * caller surface so the queue keeps evidence + a deep link even after a delete.
 */
export class CreateContentReportDto {
  @IsIn(CONTENT_REPORT_TARGET_TYPES as unknown as string[])
  targetType: string;

  @IsString()
  @IsNotEmpty()
  targetId: string;

  @IsIn(CONTENT_REPORT_REASONS as unknown as string[])
  reason: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  detail?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  snapshot?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  targetUrl?: string;

  @IsMongoId()
  @IsOptional()
  targetOwnerUserId?: string;
}

/**
 * Admin resolution of a report (action = remove content; dismiss = no action).
 * The verb is the route (`/:id/action` | `/:id/dismiss`); this carries only the
 * optional moderator note recorded on the report.
 */
export class ResolveContentReportDto {
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  note?: string;
}
