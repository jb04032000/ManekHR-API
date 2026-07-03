import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../../common/guards/admin.guard';
import { ListingModerationService } from '../services/listing-moderation.service';
import { ApproveListingDto, RejectListingDto } from '../dto/admin-review.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload populated by JwtAuthGuard -- `sub` is the User id. */
interface AdminAuthedRequest {
  user: { sub: string };
}

/**
 * Platform-admin listing moderation.
 *
 * Base path: `admin/connect/marketplace`
 * Guards: JwtAuthGuard + IsAdminGuard (user.isAdmin === true).
 *
 * The admin id is always derived from `req.user.sub`, never the body, so the
 * audit trail reflects the real operator. Mirrors the ads review console.
 */
@LegacyUnclassified()
@Controller('admin/connect/marketplace')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class ListingAdminController {
  constructor(private readonly moderation: ListingModerationService) {}

  /** Listings awaiting review. */
  @Get('review')
  listPending() {
    return this.moderation.listPending();
  }

  /** Approve a listing (publishes it live). */
  @Post('review/:id/approve')
  approve(@Param('id') id: string, @Req() req: AdminAuthedRequest, @Body() dto: ApproveListingDto) {
    return this.moderation.approve(id, req.user.sub, dto.note);
  }

  /** Reject a listing with a reason. */
  @Post('review/:id/reject')
  reject(@Param('id') id: string, @Req() req: AdminAuthedRequest, @Body() dto: RejectListingDto) {
    return this.moderation.reject(id, req.user.sub, dto.reason);
  }
}
