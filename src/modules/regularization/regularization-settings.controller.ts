import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { RegularizationSettingsService } from './regularization-settings.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule } from '../../common/enums/modules.enum';
import { UpdateRegularizationConfigDto } from './dto/regularization.dto';

/**
 * Settings controller for workspace-level regularization configuration.
 * Registered BEFORE RegularizationController in the module so the literal
 * path 'settings' takes priority over the :id param route.
 *
 * GET  /api/workspaces/:wsId/regularizations/settings  â€” read config (with DEFAULT_REG_CONFIG fallback)
 * PUT  /api/workspaces/:wsId/regularizations/settings  â€” write config (DTO enforces caps)
 */
@Controller('workspaces/:wsId/regularizations/settings')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class RegularizationSettingsController {
  constructor(private readonly service: RegularizationSettingsService) {}

  @Get()
  @RequirePermission('regularization.settings.manage')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'approve' })
  async getSettings(@Param('wsId') wsId: string) {
    const cfg = await this.service.get(wsId);
    return { success: true, data: cfg };
  }

  @Put()
  @RequirePermission('regularization.settings.manage')
  @RequireSubscription({ module: AppModule.REGULARIZATION, subFeature: 'approve' })
  async updateSettings(@Param('wsId') wsId: string, @Body() dto: UpdateRegularizationConfigDto) {
    const cfg = await this.service.update(wsId, dto);
    return { success: true, data: cfg };
  }
}
