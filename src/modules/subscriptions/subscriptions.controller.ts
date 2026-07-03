import { Controller, Get, Post, Body, UseGuards, Req, Query } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { UpdateSubscriptionDto } from './dto/subscription.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { MODULE_FEATURES_REGISTRY } from '../../common/constants/module-features.registry';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

@LegacyUnclassified()
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Public()
  @Get('plans')
  getPlans() {
    return this.subscriptionsService.getPlans();
  }

  @Public()
  @Get('tiers')
  getPublicTiers() {
    return this.subscriptionsService.getPublicTiers();
  }

  // PUBLIC-safe trial-banner config for the "45-day free trial" promo banner —
  // consumed by the in-app plans page AND the unauthenticated marketing pricing
  // page. Returns ONLY { enabled, headlineOverride, days }; no other settings.
  @Public()
  @Get('public/trial-banner')
  getPublicTrialBanner() {
    return this.subscriptionsService.getPublicTrialBannerConfig();
  }

  // PUBLIC-safe module-availability config — tells the web which LOCKED
  // modules to present as "Coming Soon" (card + nav badge) instead of the
  // plan-upgrade prompt. Presentation-only; SubscriptionGuard still 403s.
  // Admin edits the list via PATCH /admin/settings { comingSoonModules }.
  @Public()
  @Get('public/module-availability')
  getPublicModuleAvailability() {
    return this.subscriptionsService.getPublicModuleAvailability();
  }

  @Public()
  @Get('feature-registry')
  getFeatureRegistry() {
    return {
      modules: MODULE_FEATURES_REGISTRY,
      accessLevels: ['locked', 'limited', 'full'],
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('my')
  getMySubscription(@Req() req, @Query('workspaceId') workspaceId?: string) {
    // Wave A Permission-Gated UI (2026-05-15) — optional `workspaceId`
    // lets a non-owner invitee read the active workspace's plan rather
    // than their own (which is null until they purchase one). See
    // `subscriptions.service.ts::getMySubscription` for the resolution
    // chain. Omitting the param preserves the legacy by-caller behavior
    // (used on the /dashboard/subscription own-billing page).
    return this.subscriptionsService.getMySubscription(req.user.sub, workspaceId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('subscribe')
  subscribe(@Req() req, @Body() updateDto: UpdateSubscriptionDto) {
    return this.subscriptionsService.subscribe(req.user.sub, updateDto);
  }

  // Opt-in trial state for the "Start free trial" button + banner. Read-only;
  // matches the sibling JwtAuthGuard + req.user.sub pattern used across this
  // controller. Returns { trialPlanConfigured, hasUsedTrial, isInTrial,
  // trialEndsAt, trialDurationDays, canStartTrial }.
  @UseGuards(JwtAuthGuard)
  @Get('trial-state')
  getTrialState(@Req() req) {
    return this.subscriptionsService.getTrialState(req.user.sub);
  }

  // Opt-in trial: the user explicitly starts their one-time trial. Eligibility
  // + one-time-forever enforcement live in the service (throws 4xx on failure).
  // Mirrors the subscribe() write pattern (JwtAuthGuard + req.user.sub); no
  // throttler/audit here to stay consistent with the other writes on this
  // controller (subscribe/cancel/force-activate are likewise un-throttled).
  @UseGuards(JwtAuthGuard)
  @Post('start-trial')
  startTrial(@Req() req) {
    return this.subscriptionsService.startTrial(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('cancel')
  cancel(@Req() req) {
    return this.subscriptionsService.cancel(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('force-activate')
  forceActivate(@Req() req, @Body() body: { subscriptionId: string }) {
    return this.subscriptionsService.forceActivate(req.user.sub, body.subscriptionId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('cancel-scheduled')
  cancelScheduled(@Req() req, @Body() body: { subscriptionId: string }) {
    return this.subscriptionsService.cancelScheduled(req.user.sub, body.subscriptionId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('my/subscriptions')
  getMySubscriptionHistory(@Req() req) {
    return this.subscriptionsService.getMySubscriptionHistory(req.user.sub);
  }
}
