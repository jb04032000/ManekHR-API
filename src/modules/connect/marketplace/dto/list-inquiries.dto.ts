import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query for the inquiry inbox/outbox lists
 * (`GET connect/marketplace/inquiries/mine/sent|received`).
 *
 * Keyset pagination so a popular seller's inbox / prolific buyer's outbox is
 * never returned unbounded. `cursor` is the previous page's opaque keyset cursor
 * (`common/keyset-cursor`); `limit` is clamped server-side to [1, 50] (default 20).
 */
export class ListInquiriesQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
