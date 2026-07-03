import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import { ResourceScopeGuard } from '../../common/guards/resource-scope.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { WorkOrdersService } from './work-orders.service';
import { ShopFloorConfigService } from './shop-floor-config.service';
import { CreateWorkOrderDto } from './dto/create-work-order.dto';
import { UpdateWorkOrderDto } from './dto/update-work-order.dto';
import { CreateWorkOrderStepDto } from './dto/create-work-order-step.dto';
import { UpdateWorkOrderStepDto } from './dto/update-work-order-step.dto';
import { CreateStepEntryDto } from './dto/create-step-entry.dto';
import { ListWorkOrdersQueryDto } from './dto/list-work-orders.query.dto';
import { UpsertShopFloorConfigDto } from './dto/upsert-shop-floor-config.dto';

/**
 * WorkOrdersController — thin HTTP layer over WorkOrdersService. Single
 * source of truth for the web Shop Floor Control page
 * (app/dashboard/machines/shop-floor).
 *
 * Guard chain (mirrors DowntimeController):
 *   JwtAuthGuard → RolesGuard → ResourceScopeGuard → SubscriptionGuard
 *
 * Permissions mirror MachinesController CRUD: reads gate on
 * machines/view, writes on machines/edit + 'machines_basic' sub-feature.
 *
 * Route ordering invariant: the static 'work-orders' prefix keeps every
 * route below distinct; bare GET/POST 'work-orders' are declared before
 * the dynamic ':orderId' routes (Pitfall 2 — declaration order matters).
 *
 * Every mutation responds with the FULL updated WorkOrder document so the
 * client can replace it in state atomically; the global ResponseInterceptor
 * wraps it as { success: true, data: <workOrder> }.
 */
// Prefix carries an extra static `shop-floor` segment ON PURPOSE: this stack
// is Express 5 / path-to-regexp v8 (no inline param regex), and MachinesModule
// (which this module imports for the Machine model) is instantiated first, so
// its `machines/:machineId` route would otherwise SHADOW any single-segment
// `machines/<static>` route here (machineId="work-orders" -> BSONError, whole
// Shop Floor page load aborts). Nesting under `machines/shop-floor/...` makes
// every route >=2 segments after `machines`, which a lone `:machineId` can
// never match. Keep in sync with the web endpoints in
// crewroster-web/lib/api/endpoints.ts -> ApiEndpoints.workOrders.
@Controller('workspaces/:workspaceId/machines/shop-floor')
@UseGuards(JwtAuthGuard, RolesGuard, ResourceScopeGuard, SubscriptionGuard)
export class WorkOrdersController {
  constructor(
    private readonly service: WorkOrdersService,
    private readonly shopFloorConfigService: ShopFloorConfigService,
  ) {}

  // ============================================================
  // SHOP FLOOR CONFIG — static 'shop-floor-config' segment, declared
  // before the 'work-orders/:orderId' routes (Pitfall 2 — order matters).
  // ============================================================

  /**
   * GET /workspaces/:workspaceId/machines/shop-floor/config
   * List every shop-floor config in the workspace (one per location).
   */
  @Get('config')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.VIEW)
  listShopFloorConfigs(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    return this.shopFloorConfigService.list({
      workspaceId,
      userId: (req.user as any)?.sub,
    });
  }

  /**
   * PUT /workspaces/:workspaceId/machines/shop-floor/config
   * Full-replace upsert of floors + people keyed on (workspaceId, locationId).
   */
  @Put('config')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  upsertShopFloorConfig(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpsertShopFloorConfigDto,
    @Req() req: Request,
  ) {
    return this.shopFloorConfigService.upsert({ workspaceId, userId: (req.user as any)?.sub }, dto);
  }

  // ============================================================
  // WORK ORDERS
  // ============================================================

  /**
   * GET /workspaces/:workspaceId/machines/work-orders
   * List non-deleted work orders (steps embedded). Optional `?status=`.
   */
  @Get('work-orders')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.VIEW)
  list(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListWorkOrdersQueryDto,
    @Req() req: Request,
  ) {
    return this.service.list({ workspaceId, userId: (req.user as any)?.sub }, query);
  }

  /**
   * POST /workspaces/:workspaceId/machines/work-orders
   * Create a work order (code auto-reserved as WO-NNN).
   */
  @Post('work-orders')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateWorkOrderDto,
    @Req() req: Request,
  ) {
    return this.service.create({ workspaceId, userId: (req.user as any)?.sub }, dto);
  }

  /**
   * PATCH /workspaces/:workspaceId/machines/work-orders/:orderId
   * Update order fields incl. status (active/completed/archived).
   */
  @Patch('work-orders/:orderId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('orderId') orderId: string,
    @Body() dto: UpdateWorkOrderDto,
    @Req() req: Request,
  ) {
    return this.service.update({ workspaceId, userId: (req.user as any)?.sub }, orderId, dto);
  }

  /**
   * DELETE /workspaces/:workspaceId/machines/work-orders/:orderId
   * Soft-delete an order (returns the full doc with isDeleted: true).
   */
  @Delete('work-orders/:orderId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  softDelete(
    @Param('workspaceId') workspaceId: string,
    @Param('orderId') orderId: string,
    @Req() req: Request,
  ) {
    return this.service.softDelete({ workspaceId, userId: (req.user as any)?.sub }, orderId);
  }

  /**
   * POST /workspaces/:workspaceId/machines/work-orders/:orderId/steps
   * Add a step (full step payload minus entries).
   */
  @Post('work-orders/:orderId/steps')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  addStep(
    @Param('workspaceId') workspaceId: string,
    @Param('orderId') orderId: string,
    @Body() dto: CreateWorkOrderStepDto,
    @Req() req: Request,
  ) {
    return this.service.addStep({ workspaceId, userId: (req.user as any)?.sub }, orderId, dto);
  }

  /**
   * PATCH /workspaces/:workspaceId/machines/work-orders/:orderId/steps/:stepId
   * Update a step (any field incl. deps + canvas posX/posY). Dep changes
   * re-run cycle validation (400 WORK_ORDER_STEP_CYCLE).
   */
  @Patch('work-orders/:orderId/steps/:stepId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  updateStep(
    @Param('workspaceId') workspaceId: string,
    @Param('orderId') orderId: string,
    @Param('stepId') stepId: string,
    @Body() dto: UpdateWorkOrderStepDto,
    @Req() req: Request,
  ) {
    return this.service.updateStep(
      { workspaceId, userId: (req.user as any)?.sub },
      orderId,
      stepId,
      dto,
    );
  }

  /**
   * DELETE /workspaces/:workspaceId/machines/work-orders/:orderId/steps/:stepId
   * Remove a step AND strip its id from every other step's deps.
   */
  @Delete('work-orders/:orderId/steps/:stepId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  removeStep(
    @Param('workspaceId') workspaceId: string,
    @Param('orderId') orderId: string,
    @Param('stepId') stepId: string,
    @Req() req: Request,
  ) {
    return this.service.removeStep(
      { workspaceId, userId: (req.user as any)?.sub },
      orderId,
      stepId,
    );
  }

  /**
   * POST /workspaces/:workspaceId/machines/work-orders/:orderId/steps/:stepId/entries
   * Append a manual progress-log entry (byUserId from JWT, byName resolved
   * server-side, at = server time).
   */
  @Post('work-orders/:orderId/steps/:stepId/entries')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  addEntry(
    @Param('workspaceId') workspaceId: string,
    @Param('orderId') orderId: string,
    @Param('stepId') stepId: string,
    @Body() dto: CreateStepEntryDto,
    @Req() req: Request,
  ) {
    return this.service.addEntry(
      { workspaceId, userId: (req.user as any)?.sub },
      orderId,
      stepId,
      dto,
    );
  }

  /**
   * DELETE /workspaces/:workspaceId/machines/work-orders/:orderId/steps/:stepId/entries/:entryId
   * Remove an entry; step.progress recomputes from the latest remaining
   * non-null-progress entry (0 when none).
   */
  @Delete('work-orders/:orderId/steps/:stepId/entries/:entryId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  removeEntry(
    @Param('workspaceId') workspaceId: string,
    @Param('orderId') orderId: string,
    @Param('stepId') stepId: string,
    @Param('entryId') entryId: string,
    @Req() req: Request,
  ) {
    return this.service.removeEntry(
      { workspaceId, userId: (req.user as any)?.sub },
      orderId,
      stepId,
      entryId,
    );
  }
}
