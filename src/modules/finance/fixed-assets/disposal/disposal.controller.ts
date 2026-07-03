import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { DisposalService } from './disposal.service';
import { DisposeAssetDto } from './dto/dispose-asset.dto';
import { PreviewDisposalDto } from './dto/preview-disposal.dto';
import { TransferAssetDto } from './dto/transfer-asset.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/fixed-assets/:assetId')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'fixed_assets_disposal' })
export class DisposalController {
  constructor(private readonly service: DisposalService) {}

  /**
   * Preview disposal gain/loss and ITC reversal estimate without posting anything.
   * POST /workspaces/:wsId/finance/firms/:firmId/fixed-assets/:assetId/disposal/preview
   */
  @Post('disposal/preview')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  preview(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('assetId') assetId: string,
    @Body() dto: PreviewDisposalDto,
  ) {
    return this.service.preview(wsId, firmId, assetId, dto);
  }

  /**
   * Execute asset disposal (sale / scrap / writeoff) — posts partial-month depreciation
   * catch-up + disposal journal entry inside a MongoDB transaction, then marks asset disposed.
   * POST /workspaces/:wsId/finance/firms/:firmId/fixed-assets/:assetId/disposal
   */
  @Post('disposal')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  dispose(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('assetId') assetId: string,
    @Body() dto: DisposeAssetDto,
    @Req() req: any,
  ) {
    return this.service.dispose(wsId, firmId, assetId, dto, req.user?.userId);
  }

  /**
   * Transfer an asset to a different location or custodian (no ledger posting).
   * POST /workspaces/:wsId/finance/firms/:firmId/fixed-assets/:assetId/transfer
   */
  @Post('transfer')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  transfer(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('assetId') assetId: string,
    @Body() dto: TransferAssetDto,
    @Req() req: any,
  ) {
    return this.service.transfer(wsId, firmId, assetId, dto, req.user?.userId);
  }
}
