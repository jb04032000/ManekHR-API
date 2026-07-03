import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { DepreciationRunService } from './depreciation-run.service';
import { ManualRunDto } from './dto/manual-run.dto';
import { PreviewDepreciationDto } from './dto/preview-depreciation.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/fixed-assets/depreciation')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'fixed_assets_depreciation' })
export class DepreciationController {
  constructor(private readonly service: DepreciationRunService) {}

  /** POST /…/depreciation/run — trigger manual depreciation run (synchronous) */
  @Post('run')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  run(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: ManualRunDto,
    @Req() req: any,
  ) {
    return this.service.runForFirm(wsId, firmId, dto.runMonth, dto.runType, req.user?.userId);
  }

  /** POST /…/depreciation/preview — compute per-asset amounts WITHOUT posting */
  @Post('preview')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  preview(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: PreviewDepreciationDto,
  ) {
    return this.service.preview(wsId, firmId, dto.runMonth);
  }

  /** GET /…/depreciation/runs — list recent runs */
  @Get('runs')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  listRuns(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.service.listRuns(wsId, firmId, Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50);
  }

  /** GET /…/depreciation/runs/:id — get a specific run */
  @Get('runs/:id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getRun(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return this.service.findRun(wsId, firmId, id);
  }
}
