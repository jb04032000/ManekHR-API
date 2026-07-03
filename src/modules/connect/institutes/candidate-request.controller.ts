import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';
import { CandidateRequestService } from './candidate-request.service';
import { CredentialRequestsParams } from './dto/credential-request.params';
import { CreateCandidateRequestDto } from './dto/create-candidate-request.dto';

/** JWT payload populated by JwtAuthGuard. `sub` is the User id (the business). */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/company-pages/:pageId/hire-leads`: a business sends a "hire our trained
 * candidates" request to an institute page (Institutes Phase 2, Feature 4:
 * hiring-leads-to-inbox).
 *
 * What this does: the authenticated business user (`req.user.sub`) posts a hire
 * lead against an institute page; the lead lands in the institute owner's unified
 * inbox as a new `candidate_request` context card. The sender is ALWAYS
 * `req.user.sub` (never the body / a param). All gating lives in
 * `CandidateRequestService.create` (the single chokepoint): the page must exist +
 * be `kind: 'institute'` + `visibility: 'public'` (else 404), and the page owner
 * cannot lead to their own institute (self-lead block).
 *
 * Cross-module links: lives in the LEAF `ConnectInstitutesModule`, which imports
 * `ConnectEntitiesModule` (the CompanyPage model token) + `ConnectInboxModule`
 * (the `InboxService` that seeds the thread). Nothing imports this module, so no
 * cycle. `pageId` is validated by `CredentialRequestsParams` (`@IsMongoId`); the
 * body is validated by `CreateCandidateRequestDto` (optional capped message). Keep
 * the route shape in sync with the web hire-lead composer.
 *
 * Route prefix note: shares the `connect/company-pages/:pageId` namespace with the
 * CompanyPage admin + credentials controllers (a different segment tail), so it
 * reads as "this page's hire leads". NestJS routes by the full path, so there is no
 * collision with those controllers' routes.
 */
@LegacyUnclassified()
@Controller('connect/company-pages')
@UseGuards(JwtAuthGuard)
export class CandidateRequestController {
  constructor(private readonly candidateRequests: CandidateRequestService) {}

  /** Send a hire lead to an institute (business-side; gated institute + public). */
  @Post(':pageId/hire-leads')
  @Throttle({ 'connect-write': { limit: 10, ttl: 60_000 } })
  create(
    @Req() req: AuthedRequest,
    @Param() params: CredentialRequestsParams,
    @Body() dto: CreateCandidateRequestDto,
  ) {
    return this.candidateRequests.create(req.user.sub, params.pageId, dto.message);
  }
}
