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
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { RecurringInvoiceTemplateService } from './recurring-template.service';
import { CreateRecurringTemplateDto } from './dto/create-recurring-template.dto';
import { UpdateRecurringTemplateDto } from './dto/update-recurring-template.dto';

/**
 * RecurringTemplateController — D-08 full CRUD + pause/resume/trigger.
 *
 * Prefix: workspaces/:wsId/finance/firms/:firmId/sales/recurring
 */
@ApiTags('Finance - Sales')
@Controller('workspaces/:wsId/finance/firms/:firmId/sales/recurring')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'sales_recurring_billing' })
export class RecurringTemplateController {
  constructor(private readonly service: RecurringInvoiceTemplateService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Query() _filters: any) {
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
    @Body() dto: CreateRecurringTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.service.create(wsId, firmId, dto, user._id ?? user.sub);
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRecurringTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(wsId, firmId, id, dto, user._id ?? user.sub);
  }

  @Post(':id/pause')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  pause(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.pause(id);
  }

  @Post(':id/resume')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  resume(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.resume(id);
  }

  @Post(':id/trigger')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  triggerNow(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.triggerNow(wsId, firmId, id, user._id ?? user.sub);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  softDelete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() _user: any,
  ) {
    return this.service.softDelete(wsId, firmId, id);
  }
}
