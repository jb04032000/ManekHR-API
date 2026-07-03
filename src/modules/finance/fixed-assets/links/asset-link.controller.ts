import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { AssetMachineLinkService } from './asset-machine-link.service';
import { AssetItcLinkService } from './asset-itc-link.service';
import { LinkMachineDto } from './dto/link-machine.dto';
import { FromPurchaseBillDto } from './dto/from-purchase-bill.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/fixed-assets')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'fixed_assets_linking' })
export class AssetLinkController {
  constructor(
    private readonly machineLink: AssetMachineLinkService,
    private readonly itcLink: AssetItcLinkService,
  ) {}

  /** POST /...fixed-assets/:assetId/link-machine — set bidirectional FixedAsset ↔ Machine link */
  @Post(':assetId/link-machine')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  link(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('assetId') assetId: string,
    @Body() dto: LinkMachineDto,
    @Req() req: any,
  ) {
    return this.machineLink.linkMachineToAsset(wsId, firmId, assetId, dto.machineId, req.user?.userId);
  }

  /** DELETE /...fixed-assets/:assetId/link-machine — clear bidirectional link */
  @Delete(':assetId/link-machine')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  unlink(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('assetId') assetId: string,
    @Req() req: any,
  ) {
    return this.machineLink.unlinkMachine(wsId, firmId, assetId, req.user?.userId);
  }

  /** GET /...fixed-assets/:assetId/itc-schedule — return linked CapitalGoodsItcSchedule (or 404) */
  @Get(':assetId/itc-schedule')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  itcSchedule(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.itcLink.findScheduleForAsset(wsId, firmId, assetId);
  }

  /** GET /...fixed-assets/:assetId/machine — return linked Machine document (or 404) */
  @Get(':assetId/machine')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  machine(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.itcLink.findMachineForAsset(wsId, firmId, assetId);
  }

  /**
   * POST /...fixed-assets/from-purchase-bill
   * Returns a pre-filled CreateFixedAssetDto payload from a PurchaseBill line.
   * Does NOT create the asset — caller reviews and POSTs to the standard create endpoint.
   */
  @Post('from-purchase-bill')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  fromPurchaseBill(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: FromPurchaseBillDto,
  ) {
    return this.itcLink.preFillFromPurchaseBill(wsId, firmId, dto.purchaseBillId, dto.lineNo);
  }
}
