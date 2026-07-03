import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../common/guards/admin.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { SubscriptionMandateService } from './services/subscription-mandate.service';
import {
  AdminCancelMandateDto,
  AdminCreateMandateDto,
  AdminPauseMandateDto,
  AdminResumeMandateDto,
} from './dto/mandate.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Admin-scoped recurring-billing actions. Same operations as the
 * self-serve controller but operate on a target `userId` supplied in
 * the request body — useful for support flows ("user lost their phone,
 * cancel their mandate"), back-office grant of mandates after offline
 * negotiation, and incident response.
 *
 * Locked under `JwtAuthGuard + IsAdminGuard`. Throttler limits use the
 * same `billing-create` / `billing-mutate` budgets as self-serve so a
 * compromised admin account can't burn unbounded Razorpay calls.
 *
 * Idempotency-Key is honoured per-admin (not per-target-user). Two
 * admins acting on the same target user with the same key would still
 * be deduped, which is intentional — accidental concurrent admin
 * action on the same user is a higher-risk failure than a missed retry.
 */
@LegacyUnclassified()
@Controller('admin/subscriptions')
@UseGuards(JwtAuthGuard, IsAdminGuard, ThrottlerGuard)
export class BillingMandateAdminController {
  constructor(private readonly mandateService: SubscriptionMandateService) {}

  @Post('mandate/create')
  @Throttle({ 'billing-create': { limit: 5, ttl: 60_000 } })
  @Idempotent()
  createMandate(@Body() dto: AdminCreateMandateDto) {
    const { userId, ...rest } = dto;
    return this.mandateService.createMandate(userId, rest);
  }

  @Post('mandate/cancel')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  cancelMandate(@Body() dto: AdminCancelMandateDto) {
    const { userId, ...rest } = dto;
    return this.mandateService.cancelMandate(userId, rest);
  }

  @Post('mandate/pause')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  pauseMandate(@Body() dto: AdminPauseMandateDto) {
    const { userId, ...rest } = dto;
    return this.mandateService.pauseMandate(userId, rest);
  }

  @Post('mandate/resume')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  resumeMandate(@Body() dto: AdminResumeMandateDto) {
    return this.mandateService.resumeMandate(dto.userId);
  }
}
