import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import {
  RequirePermissions,
  RolesGuard,
} from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { SerialsService } from './serials.service';
import { UpdateSerialDto } from './dto/update-serial.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/inventory/serials')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({
  module: AppModule.INVENTORY,
  subFeature: 'serial_tracking',
})
export class SerialsController {
  constructor(private readonly service: SerialsService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('itemId') itemId?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    return {
      success: true,
      data: await this.service.list(wsId, firmId, { itemId, status, q }),
    };
  }

  @Get(':serialNo')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async findBySerialNo(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('serialNo') serialNo: string,
  ) {
    return {
      success: true,
      data: await this.service.findBySerialNo(wsId, firmId, serialNo),
    };
  }

  @Patch(':serialNo')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('serialNo') serialNo: string,
    @Body() dto: UpdateSerialDto,
  ) {
    return {
      success: true,
      data: await this.service.update(wsId, firmId, serialNo, dto),
    };
  }
}
