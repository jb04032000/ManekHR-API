import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { CompanyPageService } from '../services/company-page.service';
import { CompanyPageStatsService } from '../services/company-page-stats.service';
import { StorefrontService } from '../services/storefront.service';
import { NetworkService } from '../../network/network.service';
import {
  AttachStoreDto,
  CreateCompanyPageDto,
  ErpLinkDto,
  UpdateCompanyPageDto,
} from '../dto/company-page.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload populated by JwtAuthGuard -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/company-pages` -- the owner's Company Page admin.
 *
 * Person-centric: the owner is always `req.user.sub` (never the body), so
 * cross-user access is impossible. Reads + writes go through the service's
 * `loadOwned` 404-on-non-owner guard.
 */
@LegacyUnclassified()
@Controller('connect/company-pages')
@UseGuards(JwtAuthGuard)
export class CompanyPageController {
  constructor(
    private readonly service: CompanyPageService,
    private readonly network: NetworkService,
    private readonly stats: CompanyPageStatsService,
    // The attached-store link lives on Storefront.companyPageId, so the store
    // endpoints below delegate to StorefrontService (same entities module).
    private readonly storefronts: StorefrontService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(@Req() req: AuthedRequest, @Body() dto: CreateCompanyPageDto) {
    return this.service.create(req.user.sub, dto);
  }

  @Get()
  listMine(@Req() req: AuthedRequest) {
    return this.service.listMine(req.user.sub);
  }

  /** Per-page followers + 30-day posts + open-jobs + KPI totals for the hub. */
  @Get('stats')
  pageStats(@Req() req: AuthedRequest) {
    return this.stats.getMyPageStats(req.user.sub);
  }

  /** The company-page ids the caller follows -- the directory's Follow-state seed. */
  @Get('following/ids')
  async followingIds(@Req() req: AuthedRequest) {
    const ids = await this.network.listFollowedCompanyPageIds(req.user.sub);
    return { ids };
  }

  @Get(':id')
  getMine(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.getMine(req.user.sub, id);
  }

  @Patch(':id')
  update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: UpdateCompanyPageDto) {
    return this.service.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.service.remove(req.user.sub, id);
    return { ok: true };
  }

  // ── ERP link (consent + ownership-verified, ADR-0004) ──────────────────────
  // Replaces the old raw `erpWorkspaceId` create/update DTO field. The service
  // verifies the caller owns BOTH the page and the workspace (403 otherwise).

  /** Link this page to an ERP workspace the caller owns (earns the ERP badge). */
  @Post(':id/erp-link')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  linkErp(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: ErpLinkDto) {
    return this.service.linkErpWorkspace(req.user.sub, id, dto.workspaceId);
  }

  /** Unlink this page's ERP workspace (badge drops immediately). */
  @Delete(':id/erp-link')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  unlinkErp(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.unlinkErpWorkspace(req.user.sub, id);
  }

  // ── Follow ───────────────────────────────────────────────────────────────

  /** Whether the caller follows this page (drives the Follow button state). */
  @Get(':id/follow-state')
  async followState(@Req() req: AuthedRequest, @Param('id') id: string) {
    const following = await this.network.isFollowingCompanyPage(req.user.sub, id);
    return { following };
  }

  /** Follow the page. Resolves the owner (self-follow guard + notify) from the page. */
  @Post(':id/follow')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async follow(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { page } = await this.service.getPublicById(id, req.user.sub);
    await this.network.followCompanyPage(
      req.user.sub,
      id,
      String((page as { ownerUserId: unknown }).ownerUserId),
    );
    return { ok: true };
  }

  /** Unfollow the page. */
  @Delete(':id/follow')
  async unfollow(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.network.unfollowCompanyPage(req.user.sub, id);
    return { ok: true };
  }

  // ── Attached store (one storefront per page) ───────────────────────────────
  // Source of truth is Storefront.companyPageId; these delegate to
  // StorefrontService. Consumed by the web company-page manage "Store" tab.

  /** The store attached to a page the caller owns (owner view: any visibility). */
  @Get(':pageId/store')
  getAttachedStore(@Req() req: AuthedRequest, @Param('pageId') pageId: string) {
    return this.storefronts.getAttachedStoreForOwner(req.user.sub, pageId);
  }

  /** Attach (or swap) a storefront the caller owns to a page they own. */
  @Put(':pageId/store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  attachStore(
    @Req() req: AuthedRequest,
    @Param('pageId') pageId: string,
    @Body() dto: AttachStoreDto,
  ) {
    return this.storefronts.attachStorefrontToPage(req.user.sub, pageId, dto.storefrontId);
  }

  /** Unlink the page's attached store. Tolerates a page with none. */
  @Delete(':pageId/store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  unlinkStore(@Req() req: AuthedRequest, @Param('pageId') pageId: string) {
    return this.storefronts.unlinkStorefrontFromPage(req.user.sub, pageId);
  }
}
