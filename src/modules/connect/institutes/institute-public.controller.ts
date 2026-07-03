import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators/public.decorator';
import { ConnectProfileService } from '../profile/connect-profile.service';
import { CredentialRequestsParams } from './dto/credential-request.params';
import { AlumniQuery, PlacementQuery } from './dto/institute-public.query';

/**
 * `connect/company-pages/public/:pageId/...`: the PUBLIC institute-page reads
 * (Institutes Phase 2, Feature 3) - the Alumni / Open-to-work tab and the
 * Placement wall ("where our students work").
 *
 * What this does: exposes two logged-out reads of an institute's opted-in
 * students. Both are `@Public()` (SEO + a logged-out visitor browsing an
 * institute page). The DPDP gating + the institute page gate live ENTIRELY in
 * `ConnectProfileService.{getInstituteAlumni,getInstitutePlacements}` (the single
 * chokepoint): only a `public` profile whose matching credential is opted in
 * (`shareWithInstitute === true`) ever appears, and the page must exist + be
 * `kind: 'institute'` + `visibility: 'public'` (else 404). The controller adds no
 * gating of its own - it only validates the path/query params and forwards.
 *
 * Route shapes (avoid the `:slug` collision): the sibling
 * `CompanyPagePublicController` already owns this `connect/company-pages/public`
 * namespace and declares a single-segment `@Get(':slug')`. These routes are
 * TWO-segment (`:pageId/alumni`, `:pageId/placements`), and NestJS routes by the
 * full path, so they can never be captured by that one-segment `:slug`. Both
 * return an EXPLICIT empty shape (`items: []` / `employers: []`, totals 0) so the
 * web can render the invite CTA when an institute has no opted-in students yet.
 *
 * Cross-module links: lives in the LEAF `ConnectInstitutesModule`, which already
 * imports `ConnectProfileModule` (for `ConnectProfileService`). Nothing imports
 * this module, so no cycle. `pageId` is validated by `CredentialRequestsParams`
 * (`@IsMongoId`); keep route shapes in sync with the web institute Alumni /
 * Placement tabs.
 */
@Controller('connect/company-pages/public')
export class InstitutePublicController {
  constructor(private readonly profiles: ConnectProfileService) {}

  /** The institute's Alumni / Open-to-work tab, cursor-paginated. */
  @Public()
  @Get(':pageId/alumni')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  alumni(@Param() params: CredentialRequestsParams, @Query() query: AlumniQuery) {
    return this.profiles.getInstituteAlumni(params.pageId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /** The institute's Placement wall ("where our students work"). */
  @Public()
  @Get(':pageId/placements')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  placements(@Param() params: CredentialRequestsParams, @Query() query: PlacementQuery) {
    return this.profiles.getInstitutePlacements(params.pageId, { limit: query.limit });
  }
}
