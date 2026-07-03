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
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { ApiTags } from '@nestjs/swagger';
import { GrnService } from './grn.service';
import { CreateGrnDto } from './dto/create-grn.dto';

@ApiTags('Finance - Purchases')
@Controller('workspaces/:wsId/finance/firms/:firmId/purchases/grn')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'purchases_grn' })
export class GrnController {
  constructor(private readonly service: GrnService) {}

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateGrnDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createDraft(wsId, firmId, dto, user._id ?? user.sub);
  }

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Query() query: any) {
    return this.service.list(wsId, firmId, query);
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findOne(wsId, firmId, id);
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: any,
    @CurrentUser() user: any,
  ) {
    return this.service.updateDraft(wsId, firmId, id, dto, user._id ?? user.sub);
  }

  @Post(':id/confirm')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  confirmReceived(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.confirm(wsId, firmId, id, user._id ?? user.sub);
  }

  @Post(':id/cancel')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(wsId, firmId, id, user._id ?? user.sub, body?.reason);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  delete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.softDelete(wsId, firmId, id, user._id ?? user.sub);
  }
}
