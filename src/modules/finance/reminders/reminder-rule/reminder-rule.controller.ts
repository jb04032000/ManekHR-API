import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { ReminderRulesService } from './reminder-rule.service';
import { CreateReminderRuleDto, ListRulesQueryDto, UpdateReminderRuleDto } from './reminder-rule.dto';

@ApiTags('Reminder Rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.REMINDERS, subFeature: 'reminder_rules_manage' })
@Controller('workspaces/:wsId/finance/firms/:firmId/reminder-rules')
export class ReminderRulesController {
  constructor(private readonly rulesService: ReminderRulesService) {}

  @Post()
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.CREATE)
  @ApiOperation({ summary: 'Create a new reminder rule' })
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateReminderRuleDto,
  ) {
    return this.rulesService.create(wsId, firmId, dto);
  }

  @Get()
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'List reminder rules with optional filters' })
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListRulesQueryDto,
  ) {
    return this.rulesService.list(wsId, firmId, query);
  }

  @Get(':ruleId')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Get a single reminder rule by ID' })
  async get(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('ruleId') ruleId: string,
  ) {
    return this.rulesService.get(wsId, firmId, ruleId);
  }

  @Patch(':ruleId')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.EDIT)
  @ApiOperation({ summary: 'Update a reminder rule' })
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('ruleId') ruleId: string,
    @Body() dto: UpdateReminderRuleDto,
  ) {
    return this.rulesService.update(wsId, firmId, ruleId, dto);
  }

  @Delete(':ruleId')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.DELETE)
  @ApiOperation({ summary: 'Soft-delete a reminder rule' })
  async softDelete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('ruleId') ruleId: string,
  ) {
    await this.rulesService.softDelete(wsId, firmId, ruleId);
    return { deleted: true };
  }
}
