import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { SubscriptionCheckoutService } from './services/subscription-checkout.service';
import { CreateCheckoutDto, ConfirmPaymentDto } from './dto/checkout.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Self-serve subscription checkout — two-step flow:
 *   1. POST /api/subscriptions/checkout         → Razorpay order created, client opens checkout sheet
 *   2. POST /api/subscriptions/checkout/confirm → server verifies signed payload, creates Subscription
 *
 * Defence-in-depth against duplicate writes triggered by FE re-render
 * storms or aggressive client retries:
 *   - JwtAuthGuard pins every request to a userId (per-user throttler key).
 *   - Throttle caps RPS even if a runaway useEffect fires the endpoint in
 *     a tight loop. Limits chosen well above any legitimate manual cadence.
 *   - @Idempotent() honours the optional `Idempotency-Key` header — same
 *     key from same user returns the cached response instead of double-
 *     spending against Razorpay.
 *   - Service layer adds a server-side dedup window: if an open
 *     (status=created, <10 min old) SubscriptionPayment already exists for
 *     the same (userId, planId, billingCycle), it is reused rather than
 *     creating a new Razorpay order. This catches clients that don't send
 *     Idempotency-Key.
 */
@LegacyUnclassified()
@Controller('subscriptions/checkout')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class BillingCheckoutController {
  constructor(private readonly checkoutService: SubscriptionCheckoutService) {}

  @Post()
  @Throttle({ 'billing-create': { limit: 5, ttl: 60_000 } })
  @Idempotent()
  createOrder(@Req() req: any, @Body() dto: CreateCheckoutDto) {
    return this.checkoutService.createOrder(req.user.sub, dto);
  }

  @Post('confirm')
  @Throttle({ 'billing-confirm': { limit: 20, ttl: 60_000 } })
  @Idempotent()
  confirmPayment(@Req() req: any, @Body() dto: ConfirmPaymentDto) {
    return this.checkoutService.confirmPayment(req.user.sub, dto);
  }
}
