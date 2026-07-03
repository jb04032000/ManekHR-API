import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { ReminderSettingsService } from './reminder-settings.service';
import { UpdateReminderSettingsDto } from './reminder-settings.dto';

@ApiTags('Reminder Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.REMINDERS, subFeature: 'reminder_settings_manage' })
@Controller('workspaces/:wsId/finance/firms/:firmId/reminder-settings')
export class ReminderSettingsController {
  constructor(private readonly settingsService: ReminderSettingsService) {}

  @Get()
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Get reminder settings for a firm (creates defaults if missing)' })
  async get(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
  ) {
    return this.settingsService.getOrCreate(wsId, firmId);
  }

  @Patch()
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.EDIT)
  @ApiOperation({ summary: 'Update reminder settings for a firm' })
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: UpdateReminderSettingsDto,
  ) {
    return this.settingsService.update(wsId, firmId, dto);
  }
}
