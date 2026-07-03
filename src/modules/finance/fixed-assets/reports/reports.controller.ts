import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { ReportsService } from './reports.service';
import { AssetRegisterDto } from './dto/asset-register.dto';
import { DepreciationScheduleDto } from './dto/depreciation-schedule.dto';
import { BlockSummaryDto } from './dto/block-summary.dto';
import { AdditionsDisposalsDto } from './dto/additions-disposals.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/fixed-assets/reports')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'fixed_assets_reports' })
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  /** GET .../reports/asset-register — Fixed Asset Register grouped by category */
  @Get('asset-register')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  assetRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() dto: AssetRegisterDto,
  ) {
    return this.service.assetRegister(wsId, firmId, dto);
  }

  /** GET .../reports/depreciation-schedule/:assetId — per-asset monthly depreciation history */
  @Get('depreciation-schedule/:assetId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  depreciationSchedule(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('assetId') assetId: string,
    @Query() dto: DepreciationScheduleDto,
  ) {
    return this.service.depreciationSchedule(wsId, firmId, assetId, dto);
  }

  /** GET .../reports/block-summary — IT Act WDV block-wise summary */
  @Get('block-summary')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  blockSummary(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() dto: BlockSummaryDto,
  ) {
    return this.service.blockSummary(wsId, firmId, dto);
  }

  /** GET .../reports/additions-disposals — Additions & Disposals register */
  @Get('additions-disposals')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  additionsDisposals(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() dto: AdditionsDisposalsDto,
  ) {
    return this.service.additionsDisposalsRegister(wsId, firmId, dto);
  }
}
