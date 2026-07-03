import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { GstinService } from './gstin.service';
import { validateGstin } from './gstin-validator';
import { FirmsService } from '../firms/firms.service';

@ApiTags('Finance - GST')
@Controller('workspaces/:workspaceId/finance/gstin-lookup')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class GstinController {
  constructor(
    private readonly gstinService: GstinService,
    private readonly firmsService: FirmsService,
  ) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstin_lookup' })
  async lookup(
    @Param('workspaceId') wsId: string,
    @Query('gstin') gstin: string,
    @Query('firmId') firmId?: string,
  ) {
    let firm: any = undefined;
    if (firmId) {
      try {
        firm = await this.firmsService.findOne(wsId, firmId);
      } catch {
        // firm not found — fall back to platform key
      }
    }
    return this.gstinService.lookup(gstin, firm);
  }

  // Free offline validation (format + state code + check digit). No provider call, so no
  // paid gstin_lookup subfeature gate - used to validate party/firm GSTIN entry inline.
  @Get('validate')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  validate(@Query('gstin') gstin: string) {
    return validateGstin(gstin ?? '');
  }
}
