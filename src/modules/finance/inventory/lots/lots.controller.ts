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
import {
  RequirePermissions,
  RolesGuard,
} from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { LotsService } from './lots.service';
import { CreateLotDto } from './dto/create-lot.dto';
import { UpdateLotDto } from './dto/update-lot.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/inventory/lots')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'lots' })
export class LotsController {
  constructor(private readonly service: LotsService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('itemId') itemId?: string,
    @Query('godownId') godownId?: string,
    @Query('expiringInDays') expiringInDays?: string,
    @Query('q') q?: string,
  ) {
    const filters = {
      itemId,
      godownId,
      expiringInDays:
        expiringInDays !== undefined ? Number(expiringInDays) : undefined,
      q,
    };
    return { success: true, data: await this.service.list(wsId, firmId, filters) };
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async findById(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return { success: true, data: await this.service.findById(wsId, firmId, id) };
  }

  // MUST be declared before @Get(':id') to avoid routing 'movements' as an id param
  @Get(':id/movements')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async findMovements(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return { success: true, data: await this.service.findMovements(wsId, firmId, id) };
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateLotDto,
  ) {
    return { success: true, data: await this.service.create(wsId, firmId, dto) };
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateLotDto,
  ) {
    return { success: true, data: await this.service.update(wsId, firmId, id, dto) };
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  async delete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    await this.service.delete(wsId, firmId, id);
    return { success: true, data: { deleted: true } };
  }
}
