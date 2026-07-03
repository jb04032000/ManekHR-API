import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body for `POST /admin/connect/banners`. `imageUrl` holds the upload value
 * returned by `/uploads/single` (a public URL or a signed private URL that the
 * service normalises back to its `r2-private://` ref before persisting).
 */
export class CreateBannerDto {
  @IsString()
  @IsNotEmpty()
  imageUrl: string;

  @IsOptional()
  @IsString()
  linkUrl?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

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

  /** ISO-8601 window start; omit / null = live since forever. */
  @IsOptional()
  @IsISO8601()
  liveFrom?: string | null;

  /** ISO-8601 window end; omit / null = live until forever. */
  @IsOptional()
  @IsISO8601()
  liveUntil?: string | null;
}
