import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../../common/guards/optional-jwt-auth.guard';
import { Public } from '../../../common/decorators/public.decorator';
import { AppModule } from '../../../common/enums/modules.enum';
import { AuditService } from '../../audit/audit.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { ConnectProfileService } from './connect-profile.service';
import { ErpLinkService, type ErpLinkStatus } from './erp-link.service';
import { ErpVerificationService } from './erp-verification.service';
import { UpdateConnectProfileDto } from './dto/update-connect-profile.dto';
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto';
import { PeopleLookupQueryDto } from './dto/people-lookup-query.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by `JwtAuthGuard` — `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * Request shape on a `@Public()` route: `user` is present only when the caller
 * sent a valid token (the optional-auth path), absent for a logged-out viewer.
 * Used to read the viewer id for per-intent audience gating on the public read.
 */
interface OptionalAuthedRequest {
  user?: { sub: string };
}

/**
 * `/me/connect/profile` — the caller's own Connect profile.
 *
 * `JwtAuthGuard` only — Connect is feature-flagged, NOT subscription-gated
 * (build plan: flags, not `SubscriptionGuard`, in Phases 0–2). Mirrors the
 * `me/notifications` user-scoped pattern.
 */
@LegacyUnclassified()
@Controller('me/connect/profile')
@UseGuards(JwtAuthGuard)
export class ConnectProfileController {
  constructor(
    private readonly profileService: ConnectProfileService,
    private readonly erpLinkService: ErpLinkService,
    private readonly erpVerificationService: ErpVerificationService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * The caller's profile - lazily created on first read, with the linked-
   * company refs for each experience entry attached (logo + /company/[slug]
   * link in the owner's editor/preview, same as the public page).
   */
  @Get()
  get(@Req() req: AuthedRequest) {
    return this.profileService.getOwnForUser(req.user.sub);
  }

  /** Partial update of the caller's profile. */
  @Patch()
  async update(@Req() req: AuthedRequest, @Body() dto: UpdateConnectProfileDto) {
    const updated = await this.profileService.update(req.user.sub, dto);
    await this.auditService.logEvent({
      workspaceId: null, // identity-layer event — no workspace scope
      module: AppModule.CONNECT,
      entityType: 'ConnectProfile',
      entityId: String(updated._id),
      action: 'update',
      actorId: req.user.sub,
      meta: { fields: Object.keys(dto) },
    });
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.profile_updated',
      properties: { fields: Object.keys(dto) },
    });
    return updated;
  }

  /**
   * Derived ERP-linked status for the caller — folded across their active
   * employment (`WorkspaceMember` rows), not a field on the profile. Connect
   * is a standalone product: a `ConnectProfile` carries no workspace ref, so
   * the moat signal is resolved from where the user actually works.
   */
  @Get('erp-link')
  erpLink(@Req() req: AuthedRequest): Promise<ErpLinkStatus> {
    return this.erpLinkService.getUserStatus(req.user.sub);
  }

  // ── ERP-verification consent (consent-first verification, ADR-0004) ─────────
  // The PROFILE ERP badge is consent-gated: no ERP activity is read and no badge
  // shows until the user grants here. Voluntary actions are silent (no
  // notification), only audited + analytics-tracked. No request body — auth is
  // the only input (the subject is always `req.user.sub`).

  /** The consent + eligibility state the web suggestion banner + settings toggle
   *  render from: `{ eligible, consentStatus, suggestionDismissed, consentVersion }`. */
  @Get('erp-verification')
  erpVerificationState(@Req() req: AuthedRequest) {
    return this.erpVerificationService.getState(req.user.sub);
  }

  /** Grant ERP-verification consent (badge eligible). Audited + PostHog. */
  @Post('erp-verification/consent')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  grantErpConsent(@Req() req: AuthedRequest) {
    return this.erpVerificationService.grant(req.user.sub);
  }

  /** Revoke ERP-verification consent (badge off immediately). Audited + PostHog. */
  @Delete('erp-verification/consent')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  revokeErpConsent(@Req() req: AuthedRequest) {
    return this.erpVerificationService.revoke(req.user.sub);
  }

  /** Record "Not now" on the one-time suggestion banner (stops the nag). */
  @Post('erp-verification/dismiss')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  dismissErpSuggestion(@Req() req: AuthedRequest) {
    return this.erpVerificationService.dismissSuggestion(req.user.sub);
  }

  /**
   * `/connect` smart-entry state — `{ connectEnabled, onboarded }`. Drives the
   * server-side routing on the Connect home (coming-soon / onboarding / home).
   */
  @Get('entry')
  getEntry(@Req() req: AuthedRequest) {
    return this.profileService.getEntryState(req.user.sub);
  }

  /** Record the caller's one-time Connect policy/terms acceptance. */
  @Post('policy-accept')
  async acceptPolicy(@Req() req: AuthedRequest) {
    const res = await this.profileService.acceptPolicy(req.user.sub);
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.policy_accepted',
      properties: {},
    });
    return res;
  }

  /** Mark the onboarding intent flow complete (stamps `onboardedAt`). */
  @Post('onboarding')
  async completeOnboarding(@Req() req: AuthedRequest, @Body() dto: CompleteOnboardingDto) {
    const updated = await this.profileService.completeOnboarding(req.user.sub, dto.intent);
    await this.auditService.logEvent({
      workspaceId: null, // identity-layer event — no workspace scope
      module: AppModule.CONNECT,
      entityType: 'ConnectProfile',
      entityId: String(updated._id),
      action: 'update',
      actorId: req.user.sub,
      meta: { onboardingIntent: dto.intent },
    });
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.onboarding_completed',
      properties: { intent: dto.intent },
    });
    return updated;
  }
}

/**
 * `/connect/profiles/:slug` — public, unauthenticated read.
 *
 * `:slug` is a dual-input param: the human-readable `User.handle` (preferred,
 * LinkedIn-style) OR the legacy 24-hex `ObjectId` (back-compat for any old
 * link in the wild). Resolution happens once in
 * `ConnectProfileService.resolveSlugToUserId`; both forms hit the same
 * downstream code path.
 *
 * Only `public`-visibility profiles are served; everything else is 404. Backs
 * the SEO-indexable public profile page `/u/[slug]`.
 */
@Controller('connect/profiles')
export class ConnectProfilePublicController {
  constructor(
    private readonly profileService: ConnectProfileService,
    private readonly erpLinkService: ErpLinkService,
  ) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':slug')
  getPublic(@Param('slug') slug: string, @Req() req: OptionalAuthedRequest) {
    // `@Public()` keeps the route open (the global `JwtAuthGuard` early-returns
    // and does not run the strategy, so it never 401s a logged-out caller).
    // `OptionalJwtAuthGuard` is a method-level guard that runs AFTER the global
    // chain and DOES run the jwt strategy, so `req.user` is populated when a
    // valid Bearer token is present. Without it, `req.user` would always be
    // undefined here and a signed-in connection would be wrongly treated as
    // logged-out. The viewer id gates `network`-audience "open to" intents
    // server-side (a non-connection / logged-out viewer never sees them).
    return this.profileService.getPublicBySlug(slug, req.user?.sub);
  }

  /**
   * Derived ERP-linked status for a public profile — the moat badge a buyer
   * sees on `/u/[slug]`. The verdict is folded across the user's active
   * employment (`WorkspaceMember` rows) by `getUserStatus`; a `ConnectProfile`
   * itself carries no workspace ref.
   *
   * Gated through `getPublicByUserId` first, so a hidden / non-public /
   * unknown profile 404s here exactly as it does on the profile read — a
   * restricted profile never leaks an ERP-linked verdict.
   *
   * Returns ONLY the public-safe fields (`linked` + `since`). The raw activity
   * `signals` (attendance / payroll / invoice counts) are intentionally NOT
   * exposed on the public surface — privacy wall, design-decisions doc §9.1.
   */
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':slug/erp-link')
  async getPublicErpLink(
    @Param('slug') slug: string,
    @Req() req: OptionalAuthedRequest,
  ): Promise<{ linked: boolean; since: Date | null }> {
    // 404-gate: a hidden / non-public / unknown profile must not leak a verdict.
    // `OptionalJwtAuthGuard` (paired with `@Public()`) populates `req.user` when
    // a token is present so the viewer id is threaded through for parity with
    // the profile read (audience gate); this endpoint only returns linked/since,
    // never the intent details.
    const userId = await this.profileService.resolveSlugToUserId(slug);
    await this.profileService.getPublicByUserId(userId, req.user?.sub);
    const status = await this.erpLinkService.getUserStatus(userId);
    return { linked: status.linked, since: status.since };
  }
}

/**
 * `/connect/featured-workshops` — public, unauthenticated discovery feed for
 * the Day-1 home. Curated Phase-1 bootstrap (build plan B5).
 */
@LegacyUnclassified()
@Controller('connect')
export class ConnectFeaturedController {
  constructor(private readonly profileService: ConnectProfileService) {}

  @Public()
  @Get('featured-workshops')
  getFeaturedWorkshops() {
    return this.profileService.getFeaturedWorkshops();
  }

  /**
   * Batch person lookup — `GET /connect/people?ids=a,b,c`. Authed (no
   * `@Public`): hydrates raw user ids into `{ name, avatar, headline }` for
   * the people cards on the network / suggestions / search surfaces, in one
   * round-trip. The list is split, trimmed, and capped at 200.
   */
  @Get('people')
  getPeople(@Query() query: PeopleLookupQueryDto) {
    const ids = query.ids
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 200);
    return this.profileService.getPeopleByIds(ids);
  }

  /**
   * Public-safe batch person lookup -- `GET /connect/people/public?ids=a,b,c`.
   * `@Public()`: the logged-out counterpart of `getPeople`. Resolves ids to
   * `{ name, avatar, headline }` ONLY for users with a `public` Connect profile
   * (`getPublicPeopleByIds`), so an anonymous caller can never enumerate
   * arbitrary user ids. Backs the public profile activity author hydration
   * (web `getPublicActivity` -> `getPublicPeople`). Same split/trim/cap-200 as
   * the authed route. Declared before nothing else on `/connect`, distinct path
   * from `people`, so no route-precedence concern.
   */
  @Public()
  @Get('people/public')
  getPublicPeople(@Query() query: PeopleLookupQueryDto) {
    const ids = query.ids
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 200);
    return this.profileService.getPublicPeopleByIds(ids);
  }
}
