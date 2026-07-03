import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
import { GodownsService } from './godowns.service';
import { CreateGodownDto } from './dto/create-godown.dto';
import { UpdateGodownDto } from './dto/update-godown.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/inventory/godowns')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class GodownsController {
  constructor(private readonly service: GodownsService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'godowns' })
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
  ) {
    return { success: true, data: await this.service.list(wsId, firmId) };
  }

  @Get(':gId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'godowns' })
  async findById(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('gId') gId: string,
  ) {
    return { success: true, data: await this.service.findById(wsId, firmId, gId) };
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'godowns' })
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateGodownDto,
  ) {
    return { success: true, data: await this.service.create(wsId, firmId, dto) };
  }

  @Patch(':gId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'godowns' })
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('gId') gId: string,
    @Body() dto: UpdateGodownDto,
  ) {
    return { success: true, data: await this.service.update(wsId, firmId, gId, dto) };
  }

  @Delete(':gId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'godowns' })
  async delete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('gId') gId: string,
  ) {
    await this.service.delete(wsId, firmId, gId);
    return { success: true, data: { deleted: true } };
  }
}
