import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { PlanChangeService } from './services/plan-change.service';
import {
  ConfirmPlanChangeDto,
  ExecutePlanChangeDto,
  PreviewPlanChangeDto,
} from './dto/plan-change.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Self-serve plan change — upgrade / downgrade with proration (Task 4).
 *
 * Three-step flow, mirroring the checkout controller's defence-in-depth:
 *   1. POST /api/subscriptions/change-plan/preview  → proration quote (no writes)
 *   2. POST /api/subscriptions/change-plan          → execute: either a
 *        Razorpay order (upgrade with a net charge), an in-place apply
 *        (free / credit-covered upgrade), or a scheduled downgrade.
 *   3. POST /api/subscriptions/change-plan/confirm  → verify the signed
 *        Razorpay payload for an upgrade order and apply the change.
 *
 * Defence-in-depth against duplicate writes from FE re-render storms /
 * aggressive retries:
 *   - JwtAuthGuard pins each request to a userId (per-user throttler key).
 *   - @Throttle caps RPS even under a runaway useEffect. Limits chosen
 *     above any legitimate manual cadence.
 *   - @Idempotent() honours the optional `Idempotency-Key` header so a
 *     retried execute / confirm returns the cached response instead of
 *     double-spending against Razorpay.
 *   - The service adds server-side guards: the proration is recomputed
 *     server-side on execute, confirm is a race-safe created→captured
 *     transition, and a duplicate scheduled downgrade is rejected.
 */
@LegacyUnclassified()
@Controller('subscriptions/change-plan')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class PlanChangeController {
  constructor(private readonly planChangeService: PlanChangeService) {}

  @Post('preview')
  @Throttle({ 'billing-create': { limit: 10, ttl: 60_000 } })
  previewPlanChange(@Req() req: any, @Body() dto: PreviewPlanChangeDto) {
    return this.planChangeService.previewPlanChange(req.user.sub, dto);
  }

  @Post()
  @Throttle({ 'billing-create': { limit: 5, ttl: 60_000 } })
  @Idempotent()
  executePlanChange(@Req() req: any, @Body() dto: ExecutePlanChangeDto) {
    return this.planChangeService.executePlanChange(req.user.sub, dto);
  }

  @Post('confirm')
  @Throttle({ 'billing-confirm': { limit: 20, ttl: 60_000 } })
  @Idempotent()
  confirmPlanChange(@Req() req: any, @Body() dto: ConfirmPlanChangeDto) {
    return this.planChangeService.confirmPlanChange(req.user.sub, dto);
  }
}
