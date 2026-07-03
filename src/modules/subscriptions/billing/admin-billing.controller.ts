import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../common/guards/admin.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { AdminBillingService } from './services/admin-billing.service';
import { AdminPaymentLinkService } from './services/admin-payment-link.service';
import {
  AdminExtendPeriodDto,
  AdminForceCancelDto,
  AdminGrantSubscriptionDto,
  AdminIssuePaymentLinkDto,
  AdminManualPaymentDto,
  AdminOverrideEntitlementsDto,
  AdminPauseDto,
  AdminPaymentLinkListQueryDto,
  AdminResumeDto,
} from './dto/admin-billing.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Admin billing operations (D1i). Locked under JwtAuthGuard +
 * IsAdminGuard. Throttler `billing-mutate` (10/60s) on writes.
 *
 * Route grouping:
 *   POST /api/admin/billing/grant                          → admin grant subscription
 *   GET  /api/admin/billing/subscriptions/:userId          → list user subs
 *   GET  /api/admin/billing/subscriptions/by-id/:id        → fetch one sub
 *   POST /api/admin/billing/subscriptions/:id/extend       → extend period
 *   POST /api/admin/billing/subscriptions/:id/override     → entitlements override
 *   POST /api/admin/billing/subscriptions/:id/pause        → pause
 *   POST /api/admin/billing/subscriptions/:id/resume       → resume
 *   POST /api/admin/billing/subscriptions/:id/force-cancel → force cancel
 *   POST /api/admin/billing/manual-payment                 → record offline payment
 *   POST /api/admin/billing/payment-links                  → issue payment link
 *   GET  /api/admin/billing/payment-links                  → list issued links
 *   POST /api/admin/billing/payment-links/:paymentId/cancel → cancel link
 *
 * Refund + RefundPolicy + BillingPolicy + Coupon admin endpoints live
 * in their own controllers (D1e/D1g/D1h).
 */
@LegacyUnclassified()
@Controller('admin/billing')
@UseGuards(JwtAuthGuard, IsAdminGuard, ThrottlerGuard)
export class AdminBillingController {
  constructor(
    private readonly admin: AdminBillingService,
    private readonly paymentLinks: AdminPaymentLinkService,
  ) {}

  // ── grant ─────────────────────────────────────────────────────────

  @Post('grant')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  grantSubscription(@Req() req: any, @Body() dto: AdminGrantSubscriptionDto) {
    return this.admin.grantSubscription({
      adminUserId: req.user.sub,
      userId: dto.userId,
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      durationDays: dto.durationDays,
      reason: dto.reason,
    });
  }

  // ── read helpers ──────────────────────────────────────────────────

  @Get('subscriptions/by-id/:id')
  fetchSubscription(@Param('id') id: string) {
    return this.admin.fetchSubscription(id);
  }

  @Get('subscriptions/:userId')
  listUserSubscriptions(@Param('userId') userId: string) {
    return this.admin.listUserSubscriptions(userId);
  }

  // ── per-subscription mutations ────────────────────────────────────

  @Post('subscriptions/:id/extend')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  extendPeriod(@Req() req: any, @Param('id') id: string, @Body() dto: AdminExtendPeriodDto) {
    return this.admin.extendPeriod({
      adminUserId: req.user.sub,
      subscriptionId: id,
      additionalDays: dto.additionalDays,
      reason: dto.reason,
    });
  }

  @Post('subscriptions/:id/override')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  overrideEntitlements(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: AdminOverrideEntitlementsDto,
  ) {
    return this.admin.overrideEntitlements({
      adminUserId: req.user.sub,
      subscriptionId: id,
      override: dto.override,
      reason: dto.reason,
    });
  }

  @Post('subscriptions/:id/pause')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  pauseSubscription(@Req() req: any, @Param('id') id: string, @Body() dto: AdminPauseDto) {
    return this.admin.pauseSubscription({
      adminUserId: req.user.sub,
      subscriptionId: id,
      reason: dto.reason,
      resumeAt: dto.resumeAt ? new Date(dto.resumeAt) : undefined,
    });
  }

  @Post('subscriptions/:id/resume')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  resumeSubscription(@Req() req: any, @Param('id') id: string, @Body() dto: AdminResumeDto) {
    return this.admin.resumeSubscription({
      adminUserId: req.user.sub,
      subscriptionId: id,
      reason: dto.reason,
    });
  }

  @Post('subscriptions/:id/force-cancel')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  forceCancel(@Req() req: any, @Param('id') id: string, @Body() dto: AdminForceCancelDto) {
    return this.admin.forceCancel({
      adminUserId: req.user.sub,
      subscriptionId: id,
      reason: dto.reason,
      immediate: dto.immediate,
    });
  }

  // ── manual payment ────────────────────────────────────────────────

  @Post('manual-payment')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  recordManualPayment(@Req() req: any, @Body() dto: AdminManualPaymentDto) {
    return this.admin.recordManualPayment({
      adminUserId: req.user.sub,
      userId: dto.userId,
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      amountPaise: dto.amountPaise,
      paymentMethod: dto.paymentMethod,
      receiptNumber: dto.receiptNumber,
      paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : undefined,
      notes: dto.notes,
    });
  }

  // ── payment-link ──────────────────────────────────────────────────

  @Post('payment-links')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  issuePaymentLink(@Req() req: any, @Body() dto: AdminIssuePaymentLinkDto) {
    return this.paymentLinks.issuePaymentLink({
      adminUserId: req.user.sub,
      userId: dto.userId,
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      amountOverridePaise: dto.amountOverridePaise,
      reason: dto.reason,
      expireInSeconds: dto.expireInSeconds,
    });
  }

  @Get('payment-links')
  listPaymentLinks(@Query() query: AdminPaymentLinkListQueryDto) {
    return this.paymentLinks.listPaymentLinks({
      userId: query.userId,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Post('payment-links/:paymentId/cancel')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  cancelPaymentLink(@Req() req: any, @Param('paymentId') paymentId: string) {
    return this.paymentLinks.cancelPaymentLink(paymentId, req.user.sub);
  }
}
