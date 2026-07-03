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
import { BatchesService } from './batches.service';
import { CreateBatchDto } from './dto/create-batch.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/inventory/batches')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'batches' })
export class BatchesController {
  constructor(private readonly service: BatchesService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('itemId') itemId?: string,
    @Query('godownId') godownId?: string,
  ) {
    return {
      success: true,
      data: await this.service.list(wsId, firmId, { itemId, godownId }),
    };
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

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateBatchDto,
  ) {
    return { success: true, data: await this.service.create(wsId, firmId, dto) };
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: Partial<CreateBatchDto>,
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
