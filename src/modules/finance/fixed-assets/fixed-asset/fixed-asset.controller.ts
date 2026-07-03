import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { FixedAssetService } from './fixed-asset.service';
import { CreateFixedAssetDto } from './dto/create-fixed-asset.dto';
import { UpdateFixedAssetDto } from './dto/update-fixed-asset.dto';
import { ListFixedAssetsDto } from './dto/list-fixed-assets.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/fixed-assets')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'fixed_assets_register' })
export class FixedAssetController {
  constructor(private readonly service: FixedAssetService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() dto: ListFixedAssetsDto,
  ) {
    return this.service.list(wsId, firmId, dto);
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateFixedAssetDto,
    @Req() req: any,
  ) {
    return this.service.create(wsId, firmId, dto, req.user?.userId);
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
    @Body() dto: UpdateFixedAssetDto,
    @Req() req: any,
  ) {
    return this.service.update(wsId, firmId, id, dto, req.user?.userId);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  softDelete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    return this.service.softDelete(wsId, firmId, id, req.user?.userId);
  }

  @Post(':id/verify')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  markVerified(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    return this.service.markVerified(wsId, firmId, id, req.user?.userId);
  }
}
