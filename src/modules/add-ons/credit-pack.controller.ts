import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CreditPackCheckoutService } from './services/credit-pack-checkout.service';
import {
  CreateCreditPackOrderDto,
  ConfirmCreditPackPaymentDto,
} from './dto/credit-pack-checkout.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

/**
 * Wave 7 — credit-pack billing endpoints (user-initiated). Same defence-
 * in-depth as `BillingCheckoutController`: throttler caps RPS, @Idempotent
 * dedups Idempotency-Key retries, service layer reuses open intents.
 */
@LegacyUnclassified()
@Controller('add-ons/credit-pack')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class CreditPackController {
  constructor(private readonly checkoutService: CreditPackCheckoutService) {}

  @Post('order')
  @Throttle({ 'credit-pack-create': { limit: 5, ttl: 60_000 } })
  @Idempotent()
  createOrder(@Req() req: Request, @Body() dto: CreateCreditPackOrderDto) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.checkoutService.createOrder(userId, dto);
  }

  @Post('confirm')
  @Throttle({ 'credit-pack-confirm': { limit: 20, ttl: 60_000 } })
  @Idempotent()
  confirmPayment(@Req() req: Request, @Body() dto: ConfirmCreditPackPaymentDto) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.checkoutService.confirmPayment(userId, dto);
  }

  @Get('history')
  history(@Req() req: Request) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.checkoutService.listMyCreditPackPayments(userId);
  }
}
