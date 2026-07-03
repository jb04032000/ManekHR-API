import { IsString, IsNotEmpty, IsOptional, IsIn, Matches, IsDateString } from 'class-validator';

/**
 * Create a legal page. `slug` is the immutable public identifier the web routes
 * fetch by (lowercase-hyphen), so it is validated tightly and never changed via
 * update. Mirrors the Tier DTO conventions (class-validator + IsIn enums).
 */
export class CreateLegalPageDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens only',
  })
  slug: string;

  @IsIn(['platform', 'connect', 'erp'])
  product: string;

  @IsIn(['terms', 'privacy', 'guidelines'])
  kind: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsIn(['draft', 'published'])
  @IsOptional()
  status?: string;

  @IsDateString()
  @IsOptional()
  effectiveDate?: string;
}

/**
 * Update mutable fields of a legal page. `slug`/`product`/`kind` are intentionally
 * omitted — they define the public route a page resolves to, so they stay fixed
 * once seeded. Status can be flipped here (e.g. unpublish) or via the dedicated
 * publish endpoint (which also bumps `version`).
 */
export class UpdateLegalPageDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsIn(['draft', 'published'])
  @IsOptional()
  status?: string;

  @IsDateString()
  @IsOptional()
  effectiveDate?: string;
}
