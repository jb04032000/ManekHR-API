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
import { ReminderTemplatesService } from './reminder-template.service';
import { UpsertReminderTemplateDto } from './reminder-template.dto';

@ApiTags('Reminder Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.REMINDERS, subFeature: 'reminder_templates_customize' })
@Controller('workspaces/:wsId/finance/firms/:firmId/reminder-templates')
export class ReminderTemplatesController {
  constructor(private readonly templatesService: ReminderTemplatesService) {}

  @Get()
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'List reminder templates (workspace defaults + firm-specific)' })
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
  ) {
    return this.templatesService.list(wsId, firmId);
  }

  @Patch()
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.EDIT)
  @ApiOperation({ summary: 'Upsert a reminder template keyed on (channel, eventType, language)' })
  async upsert(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: UpsertReminderTemplateDto,
  ) {
    return this.templatesService.upsert(wsId, firmId, dto);
  }
}
