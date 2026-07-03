import { Controller, Get, Post, Patch, Body, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AddOnsService } from './add-ons.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PurchaseAddOnDto, CancelAddOnDto } from './dto/purchase-add-on.dto';
import { UpdateAutoRechargeConfigDto } from './dto/auto-recharge-config.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

@LegacyUnclassified()
@Controller('add-ons')
@UseGuards(JwtAuthGuard)
export class AddOnsController {
  constructor(private readonly addOnsService: AddOnsService) {}

  @Get()
  async getAvailableAddOns(@Req() req: Request) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.addOnsService.getAvailableAddOns(userId);
  }

  @Get('my')
  async getMyAddOns(@Req() req: Request) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.addOnsService.getMyAddOns(userId);
  }

  @Post('purchase')
  async purchaseAddOn(@Req() req: Request, @Body() dto: PurchaseAddOnDto) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.addOnsService.purchaseAddOn(userId, dto);
  }

  @Post('preview')
  async previewPurchase(@Req() req: Request, @Body() dto: PurchaseAddOnDto) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.addOnsService.previewPurchase(userId, dto);
  }

  @Post(':id/cancel')
  async cancelAddOn(@Req() req: Request, @Param('id') id: string, @Body() dto: CancelAddOnDto) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.addOnsService.cancelAddOn(userId, id, dto);
  }

  /**
   * Wave 7 — credits dashboard auto-recharge toggle + threshold + pack slug
   * picker. Stored on `subscription.appliedEntitlements.communications.*`.
   */
  @Patch('credit-pack/auto-recharge')
  async updateAutoRecharge(@Req() req: Request, @Body() dto: UpdateAutoRechargeConfigDto) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.addOnsService.updateAutoRechargeConfig(userId, dto);
  }
}
