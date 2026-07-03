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
import { StorefrontService } from '../services/storefront.service';
import {
  CreateStorefrontDto,
  StorefrontErpLinkDto,
  UpdateStorefrontDto,
} from '../dto/storefront.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/storefronts` -- the owner's Storefront admin. Person-centric: the
 * owner is always `req.user.sub`, never the body.
 */
@LegacyUnclassified()
@Controller('connect/storefronts')
@UseGuards(JwtAuthGuard)
export class StorefrontController {
  constructor(private readonly service: StorefrontService) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(@Req() req: AuthedRequest, @Body() dto: CreateStorefrontDto) {
    return this.service.create(req.user.sub, dto);
  }

  @Get()
  listMine(@Req() req: AuthedRequest) {
    return this.service.listMine(req.user.sub);
  }

  @Get(':id')
  getMine(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.getMine(req.user.sub, id);
  }

  @Patch(':id')
  update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: UpdateStorefrontDto) {
    return this.service.update(req.user.sub, id, dto);
  }

  /** Mark this shop as the owner's primary / pinned shop (clears the flag on the rest). */
  @Put(':id/primary')
  setPrimary(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.setPrimary(req.user.sub, id);
  }

  /** Remove the primary flag from this shop without pinning another. */
  @Delete(':id/primary')
  unsetPrimary(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.unsetPrimary(req.user.sub, id);
  }

  // ── ERP link (consent + ownership-verified, ADR-0004) ──────────────────────
  // Replaces the old raw `erpWorkspaceId` create/update DTO field. The service
  // verifies the caller owns BOTH the shop and the workspace (403 otherwise).

  /** Link this shop to an ERP workspace the caller owns (earns the ERP badge). */
  @Post(':id/erp-link')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  linkErp(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: StorefrontErpLinkDto) {
    return this.service.linkErpWorkspace(req.user.sub, id, dto.workspaceId);
  }

  /** Unlink this shop's ERP workspace (badge drops immediately). */
  @Delete(':id/erp-link')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  unlinkErp(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.unlinkErpWorkspace(req.user.sub, id);
  }

  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.service.remove(req.user.sub, id);
    return { ok: true };
  }
}
