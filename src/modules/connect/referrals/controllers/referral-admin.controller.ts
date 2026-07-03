import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../../common/guards/admin.guard';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';
import { ConnectReferralConfigService } from '../services/connect-referral-config.service';
import { ReferralService } from '../services/referral.service';
import { AdminReferralConfigDto } from '../dto/admin-referral-config.dto';
import { AdminReferralListQuery } from '../dto/admin-referral-list.query';
import { ReferralClawbackDto } from '../dto/referral-clawback.dto';

/** JWT payload shape populated by JwtAuthGuard -- sub is the User id. */
interface AdminAuthedRequest {
  user: { sub: string };
}

/**
 * Platform-admin routes for the Connect referral program.
 *
 * Base path: `admin/connect/referrals`
 * Guards: JwtAuthGuard (valid JWT) + IsAdminGuard (user.isAdmin === true).
 *
 * Surfaces the referral levers (config get/update), the referral log (paginated,
 * filterable), and the manual clawback. All admin IDs are derived from
 * `req.user.sub` -- never accepted from the request body/params -- so the audit
 * trail always reflects the real operator.
 *
 * Cross-module links:
 *  - ConnectReferralConfigService -> get/update the singleton lever doc (audited).
 *  - ReferralService -> listReferrals (log) + clawback (reverses wallet credits + audits).
 * Registered in ConnectReferralsModule.
 */
@LegacyUnclassified()
@Controller('admin/connect/referrals')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class ReferralAdminController {
  constructor(
    private readonly configService: ConnectReferralConfigService,
    private readonly referralService: ReferralService,
  ) {}

  // ---------------------------------------------------------------------------
  // Config levers (credit per side / holdback / caps / velocity / master on-off)
  // ---------------------------------------------------------------------------

  /** Returns the live referral config the admin can tune without a deploy. */
  @Get('config')
  getConfig() {
    return this.configService.getConfig();
  }

  /** Updates the referral levers; validated against hard guardrails + audited. */
  @Put('config')
  updateConfig(@Body() dto: AdminReferralConfigDto, @Req() req: AdminAuthedRequest) {
    return this.configService.updateConfig(dto, req.user.sub);
  }

  // ---------------------------------------------------------------------------
  // Referral log + clawback
  // ---------------------------------------------------------------------------

  /** Paginated referral rows, newest first, optionally filtered by status / referrer. */
  @Get()
  list(@Query() query: AdminReferralListQuery) {
    return this.referralService.listReferrals({
      status: query.status,
      referrerUserId: query.referrerUserId,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 25,
    });
  }

  /**
   * Manually claw back a single referral: reverses any credited side via the
   * wallet and marks the row rejected (`manual_clawback`). Audited as the admin
   * from req.user.sub.
   */
  @Post(':id/clawback')
  clawback(
    @Param('id') id: string,
    @Body() dto: ReferralClawbackDto,
    @Req() req: AdminAuthedRequest,
  ) {
    return this.referralService.clawback(id, dto.reason ?? '', req.user.sub);
  }
}
