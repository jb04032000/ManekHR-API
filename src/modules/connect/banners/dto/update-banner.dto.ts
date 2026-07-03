import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `PUT /admin/connect/banners/:id`. Every field optional — only the
 * provided keys are patched (see BannerService.update). `liveFrom`/`liveUntil`
 * accept `null` to explicitly clear a bound.
 */
export class UpdateBannerDto {
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsString()
  linkUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  alt?: string;

  @IsOptional()
  @IsInt()
  order?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsISO8601()
  liveFrom?: string | null;

  @IsOptional()
  @IsISO8601()
  liveUntil?: string | null;
}
