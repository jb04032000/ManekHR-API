import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../../common/guards/admin.guard';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';
import { BannerService } from '../services/banner.service';
import { CreateBannerDto } from '../dto/create-banner.dto';
import { UpdateBannerDto } from '../dto/update-banner.dto';
import { ReorderBannersDto } from '../dto/reorder-banners.dto';
import { ToggleBannerDto } from '../dto/toggle-banner.dto';

/** JWT payload populated by JwtAuthGuard — `sub` is the User id. */
interface AdminAuthedRequest {
  user: { sub: string };
}

/**
 * Platform-admin routes for the Connect feed banner carousel.
 *
 * Base path: `admin/connect/banners`
 * Guards: JwtAuthGuard (valid JWT) + IsAdminGuard (`user.isAdmin === true`).
 *
 * The admin id is always taken from `req.user.sub` (never the body) so every
 * audited write reflects the real operator. Cross-links: banner.service.ts.
 */
@LegacyUnclassified()
@Controller('admin/connect/banners')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class BannerAdminController {
  constructor(private readonly banners: BannerService) {}

  /** Full banner list (all states) for the admin console. */
  @Get()
  list() {
    return this.banners.listAdmin();
  }

  @Post()
  create(@Body() dto: CreateBannerDto, @Req() req: AdminAuthedRequest) {
    return this.banners.create(dto, req.user.sub);
  }

  /** Persist a new drag-reorder sequence. Declared before `:id` routes. */
  @Put('reorder')
  reorder(@Body() dto: ReorderBannersDto, @Req() req: AdminAuthedRequest) {
    return this.banners.reorder(dto, req.user.sub);
  }

  @Put(':id/toggle')
  toggle(@Param('id') id: string, @Body() dto: ToggleBannerDto, @Req() req: AdminAuthedRequest) {
    return this.banners.toggle(id, dto.isActive, req.user.sub);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBannerDto, @Req() req: AdminAuthedRequest) {
    return this.banners.update(id, dto, req.user.sub);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AdminAuthedRequest) {
    return this.banners.remove(id, req.user.sub);
  }
}
