import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ENTITY_VISIBILITIES } from '../schemas/entity-common';

class EntityLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;
}

/** Create a Storefront (shop). The slug is derived server-side from the name. */
export class CreateStorefrontDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  // Must be an https URL on our storage; ownership is enforced in the service.
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  logo?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  banner?: string;

  /** Textile categories this shop sells in (free tags; align to LISTING_CATEGORIES). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  categories?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => EntityLocationDto)
  location?: EntityLocationDto;

  /**
   * Optional link to one of the caller's Company Pages (the "Start selling"
   * association). The service verifies the caller owns it.
   */
  @IsOptional()
  @IsMongoId()
  companyPageId?: string;

  // ERP linking is NO LONGER accepted here (ADR-0004 / 2026-06-18 spec) — it
  // happens only via the ownership-checked `POST /connect/storefronts/:id/erp-link`
  // route (`StorefrontService.linkErpWorkspace`).

  @IsOptional()
  @IsIn(ENTITY_VISIBILITIES)
  visibility?: (typeof ENTITY_VISIBILITIES)[number];
}

/** Update a Storefront. All fields optional; the slug is immutable. */
export class UpdateStorefrontDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  // Must be an https URL on our storage; ownership is enforced in the service.
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  logo?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  banner?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  categories?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => EntityLocationDto)
  location?: EntityLocationDto;

  /** `null` unlinks the company page, an id (re)links, omit to leave unchanged. */
  @IsOptional()
  @IsMongoId()
  companyPageId?: string | null;

  // ERP linking / unlinking is NO LONGER accepted here (ADR-0004 / 2026-06-18).
  // Use the ownership-checked `POST/DELETE /connect/storefronts/:id/erp-link`
  // routes instead.

  @IsOptional()
  @IsIn(ENTITY_VISIBILITIES)
  visibility?: (typeof ENTITY_VISIBILITIES)[number];
}

/** Link a Storefront to an ERP workspace (POST :id/erp-link). The caller must own
 *  the workspace; the service rejects with 403 otherwise. Links to:
 *  StorefrontService.linkErpWorkspace + the web storefront editor link action. */
export class StorefrontErpLinkDto {
  @IsMongoId()
  workspaceId!: string;
}
