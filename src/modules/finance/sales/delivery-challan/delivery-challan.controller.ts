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
import { DeliveryChallanService } from './delivery-challan.service';
import { CreateDeliveryChallanDto } from './dto/create-delivery-challan.dto';
import { UpdateDeliveryChallanDto } from './dto/update-delivery-challan.dto';

@ApiTags('Finance - Sales')
@Controller('workspaces/:wsId/finance/firms/:firmId/sales/delivery-challans')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'sales_delivery_challans' })
export class DeliveryChallanController {
  constructor(private readonly service: DeliveryChallanService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Query() filters: any) {
    return this.service.list(wsId, firmId, filters);
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
    @Body() dto: CreateDeliveryChallanDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createDraft(wsId, firmId, dto, user._id ?? user.sub);
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryChallanDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateDraft(wsId, firmId, id, dto, user._id ?? user.sub);
  }

  @Post(':id/post')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  postVoucher(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.post(wsId, firmId, id, user._id ?? user.sub);
  }

  @Post(':id/cancel')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(wsId, firmId, id, body.reason, user._id ?? user.sub);
  }

  @Post(':id/clone')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  clone(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.clone(wsId, firmId, id, user._id ?? user.sub);
  }

  @Post(':id/send')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  send(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { channels: string[]; message?: string; recipientEmail?: string },
    @CurrentUser() user: any,
  ) {
    return this.service.sendVoucher(wsId, firmId, id, body, user._id ?? user.sub);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  voidDraft(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.voidDraft(wsId, firmId, id, user._id ?? user.sub);
  }
}
