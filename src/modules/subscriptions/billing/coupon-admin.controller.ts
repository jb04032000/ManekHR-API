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
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../common/guards/admin.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { CouponService } from './services/coupon.service';
import { CouponListQueryDto, CreateCouponDto, UpdateCouponDto } from './dto/coupon.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Admin coupon CRUD (D1e). Locked under JwtAuthGuard + IsAdminGuard.
 *
 * Throttle uses `billing-mutate` (10/60s) on writes — bursty allowed
 * for batch coupon entry but capped against accidental scripts.
 *
 * Idempotency-Key honoured on creates so a flaky network during a
 * one-off promo creation doesn't double-create the same code (the
 * unique-index on `code` would catch it but with a less friendly 409).
 */
@LegacyUnclassified()
@Controller('admin/billing/coupons')
@UseGuards(JwtAuthGuard, IsAdminGuard, ThrottlerGuard)
export class CouponAdminController {
  constructor(private readonly couponService: CouponService) {}

  @Post()
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  create(@Req() req: any, @Body() dto: CreateCouponDto) {
    return this.couponService.create(req.user.sub, dto);
  }

  @Get()
  list(@Query() query: CouponListQueryDto) {
    return this.couponService.list(query);
  }

  @Get(':id')
  fetch(@Param('id') id: string) {
    return this.couponService.fetch(id);
  }

  @Patch(':id')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.couponService.update(id, dto, req.user.sub);
  }

  @Delete(':id')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  archive(@Req() req: any, @Param('id') id: string) {
    return this.couponService.archive(id, req.user.sub);
  }

  @Get(':id/stats')
  redemptionStats(@Param('id') id: string) {
    return this.couponService.redemptionStats(id);
  }

  /**
   * D4 — coupon revenue attribution. Joins redemptions to captured
   * SubscriptionPayments to surface gross / net revenue, refunds,
   * and per-cycle breakdown driven by this coupon code.
   */
  @Get(':id/attribution')
  attribution(@Param('id') id: string) {
    return this.couponService.attribution(id);
  }
}
