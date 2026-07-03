import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { ApiTags } from '@nestjs/swagger';
import { RecurringExpenseTemplateService } from './recurring-expense-template.service';
import { CreateRecurringExpenseDto } from './dto/create-recurring-expense.dto';
import { UpdateRecurringExpenseDto } from './dto/update-recurring-expense.dto';

/**
 * 4a: Recurring expense templates (rent / electricity / maintenance etc.).
 * Prefix: workspaces/:wsId/finance/firms/:firmId/expenses/recurring
 */
@ApiTags('Finance - Purchases')
@Controller('workspaces/:wsId/finance/firms/:firmId/expenses/recurring')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'purchases_expenses' })
export class RecurringExpenseTemplateController {
  constructor(private readonly service: RecurringExpenseTemplateService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.service.list(wsId, firmId);
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findOne(wsId, firmId, id);
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateRecurringExpenseDto,
  ) {
    return this.service.create(wsId, firmId, dto);
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRecurringExpenseDto,
  ) {
    return this.service.update(wsId, firmId, id, dto);
  }

  @Post(':id/pause')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  pause(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.pause(wsId, firmId, id);
  }

  @Post(':id/resume')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  resume(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.resume(wsId, firmId, id);
  }

  @Post(':id/trigger')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  trigger(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.triggerNow(wsId, firmId, id, user?._id ?? user?.sub);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  remove(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.softDelete(wsId, firmId, id);
  }
}
