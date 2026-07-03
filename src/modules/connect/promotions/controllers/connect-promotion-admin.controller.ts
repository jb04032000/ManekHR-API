import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../../common/guards/admin.guard';
import { ConnectPromotionService } from '../services/connect-promotion.service';
import { CreateCreditDropDto } from '../dto/create-credit-drop.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload populated by JwtAuthGuard -- `sub` is the User id. */
interface AdminAuthedRequest {
  user: { sub: string };
}

/**
 * Platform-admin Connect promotions console (Phase M3.2).
 *
 * Base path: `admin/connect/promotions`
 * Guards: JwtAuthGuard + IsAdminGuard (user.isAdmin === true).
 *
 * Plan discounts, intro offers, and scheduled sale windows are managed through
 * the existing coupon engine (`admin/billing/coupons`, Connect-scoped). The one
 * new money primitive here is the free boost-credit drop. The admin id is always
 * the JWT subject, never the body, so the audit trail reflects the real operator.
 */
@LegacyUnclassified()
@Controller('admin/connect/promotions')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class ConnectPromotionAdminController {
  constructor(private readonly promotions: ConnectPromotionService) {}

  /** Recent credit-drop campaigns, newest first. */
  @Get('credit-drops')
  listDrops() {
    return this.promotions.listDrops();
  }

  /** Run a credit drop: grant free boost credits to the targeted sellers. */
  @Post('credit-drops')
  createDrop(@Req() req: AdminAuthedRequest, @Body() dto: CreateCreditDropDto) {
    return this.promotions.createDrop(req.user.sub, dto);
  }
}
