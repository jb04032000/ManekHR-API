import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { AssetCategoryService } from './asset-category.service';
import { CreateAssetCategoryDto } from './dto/create-asset-category.dto';
import { UpdateAssetCategoryDto } from './dto/update-asset-category.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/fixed-assets/categories')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'fixed_assets_categories' })
export class AssetCategoryController {
  constructor(private readonly service: AssetCategoryService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.service.list(wsId, firmId);
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateAssetCategoryDto,
    @Req() req: any,
  ) {
    return this.service.create(wsId, firmId, dto, req.user?.userId);
  }

  @Post('seed-defaults')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  seedDefaults(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.service.seedDefaults(wsId, firmId).then((count) => ({ seeded: count }));
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return this.service.findOne(wsId, firmId, id);
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAssetCategoryDto,
  ) {
    return this.service.update(wsId, firmId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  softDelete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return this.service.softDelete(wsId, firmId, id);
  }
}
