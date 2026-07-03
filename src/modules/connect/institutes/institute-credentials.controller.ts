import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';
import { ConnectProfileService } from '../profile/connect-profile.service';
import { CredentialRequestsParams, DecideCredentialParams } from './dto/credential-request.params';

/** JWT payload populated by JwtAuthGuard. `sub` is the User id (the page admin). */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/company-pages/:pageId/...`: the institute (page-owner) admin surface
 * for confirming / declining a student's self-declared training credential
 * (Institutes Phase 2, Feature 2).
 *
 * What this does: exposes the page owner's pending-credential review queue plus
 * the confirm / decline actions. The actor is ALWAYS `req.user.sub` (never the
 * body / a param), so cross-user access is impossible; the page-admin gate +
 * the cross-institute-write block both live in
 * `ConnectProfileService.{listPendingCredentialRequests,decideCredential}` (the
 * single chokepoint, the ONLY path that sets `confirmed` / `declined`).
 *
 * Cross-module links: lives in the LEAF `ConnectInstitutesModule`, which imports
 * `ConnectProfileModule` (for `ConnectProfileService`) and `ConnectEntitiesModule`
 * (so the wired `CompanyPageService.getMine` gate is available). Nothing imports
 * this module, so no cycle. Path params are validated by the param DTOs
 * (`@IsMongoId`); keep route shapes in sync with the web institute-admin client.
 *
 * Note on the route prefix: these paths share the `connect/company-pages/:pageId`
 * namespace with the CompanyPage admin controller (a different segment tail), so
 * they read naturally as "this page's credential requests". NestJS routes by the
 * full path, so there is no collision with that controller's `:id` routes.
 */
@LegacyUnclassified()
@Controller('connect/company-pages')
@UseGuards(JwtAuthGuard)
export class InstituteCredentialsController {
  constructor(private readonly profiles: ConnectProfileService) {}

  /** The institute's pending-credential review queue (page-owner only). */
  @Get(':pageId/credential-requests')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  listRequests(@Req() req: AuthedRequest, @Param() params: CredentialRequestsParams) {
    return this.profiles.listPendingCredentialRequests(req.user.sub, params.pageId);
  }

  /** Confirm a student credential linked to this institute's page. */
  @Post(':pageId/credentials/:studentUserId/:trainingId/confirm')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  confirm(@Req() req: AuthedRequest, @Param() params: DecideCredentialParams) {
    return this.profiles.decideCredential(
      req.user.sub,
      params.pageId,
      params.studentUserId,
      params.trainingId,
      'confirm',
    );
  }

  /** Decline a student credential linked to this institute's page. */
  @Post(':pageId/credentials/:studentUserId/:trainingId/decline')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  decline(@Req() req: AuthedRequest, @Param() params: DecideCredentialParams) {
    return this.profiles.decideCredential(
      req.user.sub,
      params.pageId,
      params.studentUserId,
      params.trainingId,
      'decline',
    );
  }
}
