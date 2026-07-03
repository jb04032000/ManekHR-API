import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { SubscriptionMandateService } from './services/subscription-mandate.service';
import { CancelMandateDto, CreateMandateDto, PauseMandateDto } from './dto/mandate.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Self-serve recurring billing (Razorpay Subscriptions API mandate flow).
 *
 *   POST /api/subscriptions/checkout/mandate   → create mandate, returns short_url
 *   POST /api/subscriptions/mandate/cancel     → cancel mandate (default at-cycle-end)
 *   POST /api/subscriptions/mandate/pause      → pause mandate immediately
 *   POST /api/subscriptions/mandate/resume     → resume a paused mandate
 *
 * Defence-in-depth (mirrors D1b checkout):
 *   - JwtAuthGuard pins userId per-request → per-user throttler key.
 *   - ThrottlerGuard `billing-create` (5/60s) caps mandate-create spam
 *     even on a runaway useEffect. Cancel/pause/resume use
 *     `billing-mutate` (10/60s) — bursty by design (UI may double-tap).
 *   - `@Idempotent()` honours optional `Idempotency-Key` header → cached
 *     response from Redis short-circuits client retries.
 *   - Service layer adds a 10-min reuse-window dedup against open
 *     pending mandates so even clients that don't send Idempotency-Key
 *     don't burn fresh Razorpay subscriptions on every re-render.
 */
@LegacyUnclassified()
@Controller('subscriptions')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class BillingMandateController {
  constructor(private readonly mandateService: SubscriptionMandateService) {}

  @Post('checkout/mandate')
  @Throttle({ 'billing-create': { limit: 5, ttl: 60_000 } })
  @Idempotent()
  createMandate(@Req() req: any, @Body() dto: CreateMandateDto) {
    return this.mandateService.createMandate(req.user.sub, dto);
  }

  @Post('mandate/cancel')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  cancelMandate(@Req() req: any, @Body() dto: CancelMandateDto) {
    return this.mandateService.cancelMandate(req.user.sub, dto);
  }

  @Post('mandate/pause')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  pauseMandate(@Req() req: any, @Body() dto: PauseMandateDto) {
    return this.mandateService.pauseMandate(req.user.sub, dto);
  }

  @Post('mandate/resume')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  resumeMandate(@Req() req: any) {
    return this.mandateService.resumeMandate(req.user.sub);
  }
}
