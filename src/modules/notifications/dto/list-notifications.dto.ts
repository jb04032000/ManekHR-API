import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query for `GET /me/notifications` (the cross-workspace bell list, shared by the
 * Connect + ERP inboxes). Previously raw `@Query('x')` strings with the page size
 * clamped only inside the service; this DTO enforces the bound at the edge so a
 * client `?limit=99999` is rejected (400) rather than silently capped.
 *
 * `limit` is clamped to [1, 100] (the service's own default page size; the FE
 * bell pages at 30). `before` is the keyset cursor (the previous page's last
 * `createdAt` ISO). Keep the field set in sync with `MeNotificationsController.list`
 * — `forbidNonWhitelisted` rejects any param not declared here.
 */
export class ListNotificationsQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Keyset cursor: the previous page's last notification `createdAt` (ISO). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  before?: string;

  /** Inbox scope — `connect` / `erp` ("one engine, two inboxes"). */
  @IsOptional()
  @IsIn(['connect', 'erp'])
  product?: 'connect' | 'erp';
}
