import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';
import { ConnectPageInviteService } from './connect-page-invite.service';
import { CredentialRequestsParams } from './dto/credential-request.params';
import { BulkInviteDto } from './dto/bulk-invite.dto';

/** JWT payload populated by JwtAuthGuard. `sub` is the User id (the page owner). */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/company-pages/:pageId/student-invites`: the institute (page-owner)
 * surface for bulk-inviting students + reading the page's invite/referral metrics
 * (Institutes Phase 2, Feature 5).
 *
 * What this does:
 *  - POST .../student-invites          -> bulk-invite a list of phone numbers;
 *    returns counts + the raw per-row tokens so the FE can build wa.me share links.
 *  - GET  .../student-invites/summary  -> the page's `joinedCount` (users whose
 *    first-touch referral is this page) + `pendingCount` (outstanding invites).
 *
 * The actor is ALWAYS `req.user.sub` (never the body / a param). Both the
 * page-owner gate AND the strict per-page scoping live in
 * `ConnectPageInviteService` (the single chokepoint): every method calls
 * `CompanyPageService.getMine` (404 for a non-owner; no existence leak), and
 * `summary` counts only the caller's OWN pageId (no cross-institute metric leak).
 *
 * Cross-module links: lives in the LEAF `ConnectInstitutesModule`, which imports
 * `ConnectEntitiesModule` (the CompanyPage model token + `CompanyPageService`).
 * Nothing imports this module, so no cycle. `pageId` is validated by
 * `CredentialRequestsParams` (`@IsMongoId`); the body is validated by
 * `BulkInviteDto` (non-empty array of non-empty strings, capped at 200). Keep the
 * route shapes in sync with the web bulk-invite composer + the institute admin
 * dashboard.
 *
 * Route prefix note: shares the `connect/company-pages/:pageId` namespace with the
 * CompanyPage admin + credentials + hire-leads controllers (a different segment
 * tail). NestJS routes by the full path, so there is no collision.
 */
@LegacyUnclassified()
@Controller('connect/company-pages')
@UseGuards(JwtAuthGuard)
export class StudentInvitesController {
  constructor(private readonly invites: ConnectPageInviteService) {}

  /** Bulk-invite a list of student phone numbers from this page (page-owner only). */
  @Post(':pageId/student-invites')
  @Throttle({ 'connect-write': { limit: 10, ttl: 60_000 } })
  bulkInvite(
    @Req() req: AuthedRequest,
    @Param() params: CredentialRequestsParams,
    @Body() dto: BulkInviteDto,
  ) {
    return this.invites.bulkInvite(req.user.sub, params.pageId, dto.phones);
  }

  /** This page's invite/referral metrics (page-owner only; scoped to this pageId). */
  @Get(':pageId/student-invites/summary')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  summary(@Req() req: AuthedRequest, @Param() params: CredentialRequestsParams) {
    return this.invites.summary(req.user.sub, params.pageId);
  }
}
