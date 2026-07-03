import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../../common/guards/admin.guard';
import { AdsAdminService } from '../services/ads-admin.service';
import { ConnectPricingConfigService } from '../services/connect-pricing-config.service';
import { AdminApproveDto, AdminRejectDto } from '../dto/admin-review.dto';
import { AdminPlacementDto } from '../dto/admin-placement.dto';
import { AdminPricingConfigDto } from '../dto/admin-pricing-config.dto';
import { AdminWalletAdjustDto } from '../dto/admin-wallet-adjust.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by JwtAuthGuard -- sub is the User id. */
interface AdminAuthedRequest {
  user: { sub: string };
}

/**
 * Platform-admin routes for the Connect ads sub-system.
 *
 * Base path: `admin/connect/ads`
 * Guards: JwtAuthGuard (valid JWT required) + IsAdminGuard (user.isAdmin === true).
 *
 * All admin IDs are derived from req.user.sub -- never accepted from the
 * request body -- so the audit trail always reflects the actual operator.
 *
 * Module registration: handled in T33 (AdsModule providers / exports).
 */
@LegacyUnclassified()
@Controller('admin/connect/ads')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class AdsAdminController {
  constructor(
    private readonly adsAdminService: AdsAdminService,
    // Pricing levers (boost bid / min budget / durations / top-up presets).
    // Separate service so the pricing config is reusable by the public read
    // controller + BoostService without going through the admin facade.
    private readonly pricingConfig: ConnectPricingConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Creative review queue
  // ---------------------------------------------------------------------------

  /** Returns all pending creatives enriched with their campaign context. */
  @Get('review')
  listPending() {
    return this.adsAdminService.listPending();
  }

  /** Returns all LIVE boosts (active / paused) for the admin take-down panel. */
  @Get('live')
  listLive() {
    return this.adsAdminService.listLive();
  }

  /** Approve a creative; activates the parent campaign for delivery. */
  @Post('review/:id/approve')
  approve(@Param('id') id: string, @Req() req: AdminAuthedRequest, @Body() dto: AdminApproveDto) {
    return this.adsAdminService.approve(id, req.user.sub, dto.note);
  }

  /** Reject a creative; marks campaign rejected and releases unspent budget. */
  @Post('review/:id/reject')
  reject(@Param('id') id: string, @Req() req: AdminAuthedRequest, @Body() dto: AdminRejectDto) {
    return this.adsAdminService.reject(id, req.user.sub, dto.reason);
  }

  // ---------------------------------------------------------------------------
  // Placement configuration
  // ---------------------------------------------------------------------------

  /** Returns all placement slots. */
  @Get('placements')
  listPlacements() {
    return this.adsAdminService.listPlacements();
  }

  /** Updates floor CPM and enabled flag for a placement slot. */
  @Put('placements/:key')
  updatePlacement(
    @Param('key') key: string,
    @Body() dto: AdminPlacementDto,
    @Req() req: AdminAuthedRequest,
  ) {
    return this.adsAdminService.updatePlacement(key, dto, req.user.sub);
  }

  // ---------------------------------------------------------------------------
  // Pricing levers (boost bid / min budget / durations / top-up presets)
  // ---------------------------------------------------------------------------

  /** Returns the live pricing config the owner can tune without a deploy. */
  @Get('pricing')
  getPricing() {
    return this.pricingConfig.getConfig();
  }

  /** Updates the pricing levers; validated against hard guardrails + audited. */
  @Put('pricing')
  updatePricing(@Body() dto: AdminPricingConfigDto, @Req() req: AdminAuthedRequest) {
    return this.pricingConfig.updateConfig(dto, req.user.sub);
  }

  // ---------------------------------------------------------------------------
  // Wallet adjustment (admin manual credit / debit)
  // ---------------------------------------------------------------------------

  /** Returns an advertiser's wallet (balance / grantBalance / reserved). */
  @Get('wallet/:userId')
  getWallet(@Param('userId') userId: string) {
    return this.adsAdminService.getWallet(userId);
  }

  /** Applies a signed manual credit/debit to an advertiser's spendable balance. */
  @Post('wallet/:userId/adjust')
  adjustWallet(
    @Param('userId') userId: string,
    @Body() dto: AdminWalletAdjustDto,
    @Req() req: AdminAuthedRequest,
  ) {
    return this.adsAdminService.adjustWallet(userId, dto, req.user.sub);
  }

  // ---------------------------------------------------------------------------
  // Revenue
  // ---------------------------------------------------------------------------

  /** Returns platform-wide total ad spend. */
  @Get('revenue')
  getRevenue() {
    return this.adsAdminService.getRevenue();
  }
}
