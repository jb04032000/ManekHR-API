import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../common/guards/admin.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { BillingPolicyService } from './services/billing-policy.service';
import { UpdateBillingPolicyDto } from './dto/billing-policy.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Admin BillingPolicy management (D1g/D1j).
 *
 * Single-document configuration — `GET` returns the current global
 * policy (creates one with defaults if missing); `PATCH` does a deep
 * merge upsert. The policy controls:
 *   - Failed-payment retry counts (informational; Razorpay's own
 *     dashboard config drives the actual retries).
 *   - Grace-period duration + read-only enforcement + sales CTA.
 *   - Trial defaults (per-plan can override).
 *   - Sales contact info displayed on dunning + expired emails.
 *
 * Cache: BillingPolicyService keeps a 60-second in-memory cache;
 * `upsert` flushes it. Within ~60s of a PATCH every replica will
 * pick up the new policy without inter-process invalidation.
 */
@LegacyUnclassified()
@Controller('admin/billing/policy')
@UseGuards(JwtAuthGuard, IsAdminGuard, ThrottlerGuard)
export class BillingPolicyAdminController {
  constructor(private readonly policyService: BillingPolicyService) {}

  @Get()
  fetch() {
    return this.policyService.getPolicy();
  }

  @Patch()
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  update(@Req() req: any, @Body() dto: UpdateBillingPolicyDto) {
    return this.policyService.upsert(dto, req.user.sub);
  }
}
