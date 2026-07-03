import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import {
  RolesGuard,
  RequirePermissions,
} from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { BomService } from './bom.service';
import { CreateBomDto } from './dto/create-bom.dto';
import { UpdateBomDto } from './dto/update-bom.dto';
import { ListBomDto } from './dto/list-bom.dto';

/**
 * BomController
 *
 * Base path: /workspaces/:wsId/finance/firms/:firmId/manufacturing/bom
 *
 * All routes require JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: AppModule.FINANCE subFeature 'bom' (D-13 — Pro+ plan).
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/manufacturing/bom')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.MANUFACTURING, subFeature: 'bom_crud' })
export class BomController {
  constructor(private readonly bomService: BomService) {}

  /** GET /...manufacturing/bom — list BoMs with optional filters */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() filters: ListBomDto,
  ) {
    const data = await this.bomService.list(wsId, firmId, filters);
    return { success: true, data };
  }

  /** POST /...manufacturing/bom — create BoM */
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateBomDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.bomService.create(wsId, firmId, dto, user._id ?? user.sub);
    return { success: true, data };
  }

  /** GET /...manufacturing/bom/:bomId — get single BoM */
  @Get(':bomId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async detail(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bomId') bomId: string,
  ) {
    const data = await this.bomService.findById(wsId, firmId, bomId);
    return { success: true, data };
  }

  /** PUT /...manufacturing/bom/:bomId — update BoM (increments versionNo) */
  @Put(':bomId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bomId') bomId: string,
    @Body() dto: UpdateBomDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.bomService.update(wsId, firmId, bomId, dto, user._id ?? user.sub);
    return { success: true, data };
  }

  /** DELETE /...manufacturing/bom/:bomId — soft delete (guard: no in-progress MVs) */
  @Delete(':bomId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  async remove(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bomId') bomId: string,
    @CurrentUser() user: any,
  ) {
    await this.bomService.delete(wsId, firmId, bomId, user._id ?? user.sub);
    return { success: true, data: { ok: true } };
  }

  /** GET /...manufacturing/bom/:bomId/explosion — explode multi-level BoM to leaf components */
  @Get(':bomId/explosion')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async explosion(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bomId') bomId: string,
    @Query('requestedQty') requestedQty?: string,
  ) {
    const qty = requestedQty ? Number(requestedQty) : undefined;
    const data = await this.bomService.explode(wsId, firmId, bomId, qty);
    return { success: true, data };
  }

  /** GET /...manufacturing/bom/:bomId/standard-cost — compute standard cost from component moving-avg costs */
  @Get(':bomId/standard-cost')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async standardCost(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bomId') bomId: string,
    @Query('persist') persist?: string,
  ) {
    const data = await this.bomService.computeStandardCost(
      wsId,
      firmId,
      bomId,
      persist === 'true',
    );
    return { success: true, data };
  }
}
