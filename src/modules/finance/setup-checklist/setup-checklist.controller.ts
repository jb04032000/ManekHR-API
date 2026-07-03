import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { SetupChecklistService } from './setup-checklist.service';

@ApiTags('Finance - Settings')
@Controller('workspaces/:workspaceId/finance/firms/:firmId/setup-checklist')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
export class SetupChecklistController {
  constructor(private readonly checklistService: SetupChecklistService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getChecklist(@Param('workspaceId') wsId: string, @Param('firmId') firmId: string) {
    return this.checklistService.getChecklist(wsId, firmId);
  }
}
