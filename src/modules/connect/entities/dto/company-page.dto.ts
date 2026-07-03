import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ENTITY_VISIBILITIES } from '../schemas/entity-common';
import { COMPANY_INSTITUTE_MODES, COMPANY_PAGE_KINDS } from '../schemas/company-page.schema';

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

class CompanyIndustryPanelDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  specialization?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  machineCapacity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  production?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  languages?: string[];
}

/**
 * The institute "what we teach" panel. Parallel to `CompanyIndustryPanelDto`;
 * all fields optional. `coursesOffered` is a free-tag course-name list (capped),
 * `modes` is constrained to the institute delivery enum, `languages` mirrors the
 * industry panel. Only meaningful on a `kind: 'institute'` page.
 */
class CompanyInstitutePanelDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  coursesOffered?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(COMPANY_INSTITUTE_MODES, { each: true })
  modes?: Array<(typeof COMPANY_INSTITUTE_MODES)[number]>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  languages?: string[];
}

/**
 * One intro / teaser video. Mirrors the marketplace `ListingVideoDto` (the
 * canonical pattern): `url` + optional `posterUrl` are both https-only on OUR
 * storage (the service runs them through the media-ownership guard); `durationSec`
 * is NOT accepted from the body (the service derives it server-side from the owned
 * upload record), so a client cannot forge a clip length. The 60s cap is enforced
 * upstream in the uploads media-probe (`connect-company-video` policy).
 */
class CompanyPageVideoDto {
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  posterUrl?: string;
}

/**
 * Public directory browse/filter query for
 * `GET /connect/company-pages/public/browse`. All optional: no params returns
 * the first page of all public pages, newest first.
 */
export class BrowseCompanyPagesDto {
  /** Free-text match on the page name or a specialization tag. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  /** Filter by location district (case-insensitive contains). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  /** Filter by an exact specialization tag (e.g. `embroidery-zari`). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  specialization?: string;

  /**
   * Filter the directory to a single page kind. `institute` powers the
   * "Institutes" directory tab; `business` the ordinary directory. Omit for all
   * pages (the unchanged default, so every existing caller is unaffected).
   */
  @IsOptional()
  @IsIn(COMPANY_PAGE_KINDS)
  kind?: (typeof COMPANY_PAGE_KINDS)[number];

  /** Keep only ERP-linked pages (the real trust filter). Accepts `1`/`true`. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  erpVerified?: boolean;

  /** Keep only pages whose owner's seller rating is at least this (e.g. 4 or 4.5). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  minRating?: number;

  /** Result order: `recent` (default), `name` (A->Z), or `erpVerified` (ERP-linked first). */
  @IsOptional()
  @IsIn(['recent', 'name', 'erpVerified'])
  sort?: 'recent' | 'name' | 'erpVerified';

  /** 1-based page number. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Page size (clamped 1..48 server-side). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  pageSize?: number;
}

/** Query the distinct district / city values across public pages (directory
 *  location search + the create/edit autocomplete). */
export class DistinctLocationsDto {
  @IsIn(['district', 'city'])
  field!: 'district' | 'city';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

/** Create a Company Page. The slug is derived server-side from the name. */
export class CreateCompanyPageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  about?: string;

  // Must be an https URL on our storage; ownership is enforced in the service.
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  logo?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  banner?: string;

  /**
   * Intro video(s). Capped at ONE (`@ArrayMaxSize(1)`) - the page carries a single
   * short clip; the array shape leaves room for "multiple videos" later without a
   * payload change. Each url + posterUrl is ownership-checked by the service;
   * durationSec is server-derived (never trusted from the body). Mirrors the
   * marketplace CreateListingDto.videos contract exactly.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompanyPageVideoDto)
  @ArrayMaxSize(1)
  videos?: CompanyPageVideoDto[];

  /**
   * Whether the page is an ordinary business (default) or a training institute.
   * Omit for a business page; pass `institute` to create an institute page (then
   * `institutePanel` carries the course / mode / language details).
   */
  @IsOptional()
  @IsIn(COMPANY_PAGE_KINDS)
  kind?: (typeof COMPANY_PAGE_KINDS)[number];

  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyIndustryPanelDto)
  industryPanel?: CompanyIndustryPanelDto;

  /** The institute "what we teach" panel (only meaningful on an institute page). */
  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyInstitutePanelDto)
  institutePanel?: CompanyInstitutePanelDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => EntityLocationDto)
  location?: EntityLocationDto;

  // ERP linking is NO LONGER accepted here (ADR-0004 / 2026-06-18 spec). Raw
  // `erpWorkspaceId` acceptance let a crafted request inherit another
  // workspace's trust with no ownership check. Linking now happens ONLY via the
  // ownership-checked `POST /connect/company-pages/:id/erp-link` route
  // (`CompanyPageService.linkErpWorkspace`), which verifies the caller owns the
  // workspace via `isWorkspaceOwner`.

  @IsOptional()
  @IsIn(ENTITY_VISIBILITIES)
  visibility?: (typeof ENTITY_VISIBILITIES)[number];
}

/** Link a Company Page to an ERP workspace (POST :id/erp-link). The caller must
 *  own the workspace; the service rejects with 403 otherwise. The page is taken
 *  from the route param + caller ownership. Links to: CompanyPageService.linkErpWorkspace
 *  + the web "Link this page to my ERP workspace" action. */
export class ErpLinkDto {
  @IsMongoId()
  workspaceId!: string;
}

/**
 * Attach a storefront to a company page (PUT :pageId/store). The storefront and
 * the page must both be owned by the caller; the service enforces one store per
 * page. Links to: StorefrontService.attachStorefrontToPage + the web
 * AttachStorePicker.
 */
export class AttachStoreDto {
  @IsMongoId()
  storefrontId!: string;
}

/** Update a Company Page. All fields optional; the slug is immutable. */
export class UpdateCompanyPageDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  about?: string;

  // Must be an https URL on our storage; ownership is enforced in the service.
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  logo?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  banner?: string;

  /**
   * Intro video(s), capped at one. On update the service grandfathers a video
   * already on the page (its url/posterUrl stay valid without a fresh ownership
   * record) and only ownership-checks a newly-added clip; durationSec is
   * re-derived server-side. Omit to leave the existing video unchanged; pass `[]`
   * to clear it. Mirrors the marketplace UpdateListingDto.videos contract.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompanyPageVideoDto)
  @ArrayMaxSize(1)
  videos?: CompanyPageVideoDto[];

  /** Change the page kind (business <-> institute). Omit to leave unchanged. */
  @IsOptional()
  @IsIn(COMPANY_PAGE_KINDS)
  kind?: (typeof COMPANY_PAGE_KINDS)[number];

  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyIndustryPanelDto)
  industryPanel?: CompanyIndustryPanelDto;

  /** The institute "what we teach" panel. Omit to leave unchanged. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyInstitutePanelDto)
  institutePanel?: CompanyInstitutePanelDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => EntityLocationDto)
  location?: EntityLocationDto;

  // ERP linking / unlinking is NO LONGER accepted here (ADR-0004 / 2026-06-18).
  // Use the ownership-checked `POST/DELETE /connect/company-pages/:id/erp-link`
  // routes instead. Removing it from the update DTO closes the silent-link path.

  @IsOptional()
  @IsIn(ENTITY_VISIBILITIES)
  visibility?: (typeof ENTITY_VISIBILITIES)[number];
}
