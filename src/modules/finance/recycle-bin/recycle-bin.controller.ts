import { Controller, Get, Post, Delete, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
// Side-effect import: registers the Express.Request.user typing.
import '../../../common/types/express-request.augmentation';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { RecycleBinService } from './recycle-bin.service';

@ApiTags('Finance - Settings')
@Controller('workspaces/:workspaceId/finance/firms/:firmId/recycle-bin')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_recycle_bin' })
export class RecycleBinController {
  constructor(private readonly recycleBinService: RecycleBinService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findAll(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('type') type?: string,
  ) {
    return this.recycleBinService.findAll(wsId, firmId, type);
  }

  @Post(':id/restore')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  restore(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Query('type') type: string,
    @Req() req: Request,
  ) {
    // Actor is required for the SEC-2 audit trail; the route is JwtAuth-guarded
    // so req.user is always present.
    return this.recycleBinService.restore(wsId, firmId, id, type, req.user?.sub ?? '');
  }

  @Delete(':id/permanent')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  permanentDelete(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Query('type') type: string,
    @Req() req: Request,
  ) {
    return this.recycleBinService.permanentDelete(wsId, firmId, id, type, req.user?.sub ?? '');
  }
}
