import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import {
  RolesGuard,
  RequirePermissions,
} from '../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { ItemsService } from './items.service';
import { CreateItemDto } from './dto/create-item.dto';

@Controller('workspaces/:workspaceId/finance/firms/:firmId/items')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_items_master' })
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findAll(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
  ) {
    return this.itemsService.findAll(wsId, firmId);
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateItemDto,
  ) {
    return this.itemsService.create(wsId, firmId, dto);
  }

  @Get(':itemId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.itemsService.findOne(wsId, firmId, itemId);
  }

  @Patch(':itemId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('itemId') itemId: string,
    @Body() dto: Partial<CreateItemDto>,
  ) {
    return this.itemsService.update(wsId, firmId, itemId, dto);
  }

  @Delete(':itemId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  remove(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.itemsService.remove(wsId, firmId, itemId);
  }
}
