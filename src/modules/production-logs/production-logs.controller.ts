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
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  RolesGuard,
  RequirePermissions,
} from '../../common/guards/roles.guard';
import {
  ResourceScopeGuard,
  assertMachineInScope,
  getScopedMachineIds,
} from '../../common/guards/resource-scope.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';
import { MACHINES_P2_SUBFEATURES } from '../subscriptions/machines-plan-migration.service';
import { ProductionLogsService } from './production-logs.service';
import { CreateProductionLogDto } from './dto/create-production-log.dto';
import { UpdateProductionLogDto } from './dto/update-production-log.dto';
import { BulkCreateProductionLogDto } from './dto/bulk-create-production-log.dto';
import { ListProductionLogsQueryDto } from './dto/list-production-logs.query.dto';

const SUB_FEATURE = MACHINES_P2_SUBFEATURES.MACHINES_PRODUCTION;

/**
 * ProductionLogsController â€” thin HTTP layer over ProductionLogsService.
 *
 * Guard chain: JwtAuthGuard â†’ RolesGuard â†’ ResourceScopeGuard â†’ SubscriptionGuard
 *
 * Route ordering invariant (Pitfall 2):
 *   All static production-logs/* routes are declared BEFORE
 *   any dynamic :machineId/* routes to prevent NestJS from
 *   interpreting 'production-logs' as a machineId value.
 */
@Controller('workspaces/:workspaceId/machines')
@UseGuards(JwtAuthGuard, RolesGuard, ResourceScopeGuard, SubscriptionGuard)
export class ProductionLogsController {
  constructor(private readonly service: ProductionLogsService) {}

  // ============================================================
  // STATIC ROUTES FIRST â€” prevent Pitfall 2 route collision
  // ============================================================

  /**
   * GET /workspaces/:workspaceId/machines/production-logs/peek-next-code
   * Preview the next PROD-NNN code without reserving it.
   */
  @Get('production-logs/peek-next-code')
  @RequirePermissions(AppModule.MACHINES, 'machines.production.view')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  peekNextCode(@Param('workspaceId') workspaceId: string) {
    return this.service.peekNextCode(workspaceId);
  }

  /**
   * GET /workspaces/:workspaceId/machines/production-logs
   * List all production logs across the workspace (scoped to caller's machine scope if any).
   */
  @Get('production-logs')
  @RequirePermissions(AppModule.MACHINES, 'machines.production.view')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async listWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Query() filters: ListProductionLogsQueryDto,
    @Req() req: Request,
  ) {
    return this.service.list(
      {
        workspaceId,
        scopedMachineIds: getScopedMachineIds(req),
      },
      filters,
      undefined,
    );
  }

  /**
   * POST /workspaces/:workspaceId/machines/production-logs/bulk
   * Bulk-create production logs â€” partial-success; individual failures do NOT abort batch.
   * Per-item scope checking happens inside service.bulkCreate (Pitfall 7).
   */
  @Post('production-logs/bulk')
  @RequirePermissions(AppModule.MACHINES, 'machines.production.log')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async bulkCreate(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: BulkCreateProductionLogDto,
    @Req() req: Request,
  ) {
    const tz = await this.service.getWorkspaceTimezone(workspaceId);
    return this.service.bulkCreate(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        workspaceTimezone: tz,
        scopedMachineIds: getScopedMachineIds(req),
      },
      dto,
    );
  }

  // ============================================================
  // DYNAMIC ROUTES â€” per-machine sub-resource paths
  // ============================================================

  /**
   * GET /workspaces/:workspaceId/machines/:machineId/production-logs
   * List production logs for a specific machine (scope-gated).
   */
  @Get(':machineId/production-logs')
  @RequirePermissions(AppModule.MACHINES, 'machines.production.view')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async listForMachine(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Query() filters: ListProductionLogsQueryDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    return this.service.list(
      {
        workspaceId,
        scopedMachineIds: getScopedMachineIds(req),
      },
      filters,
      machineId,
    );
  }

  /**
   * POST /workspaces/:workspaceId/machines/:machineId/production-logs
   * Create a single production log for a specific machine.
   */
  @Post(':machineId/production-logs')
  @RequirePermissions(AppModule.MACHINES, 'machines.production.log')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async create(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Body() dto: CreateProductionLogDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    const tz = await this.service.getWorkspaceTimezone(workspaceId);
    return this.service.create(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        workspaceTimezone: tz,
        scopedMachineIds: getScopedMachineIds(req),
      },
      machineId,
      dto,
    );
  }

  /**
   * PATCH /workspaces/:workspaceId/machines/:machineId/production-logs/:logId
   * Update mutable metric fields (stitchCount, pieceCount, hoursLogged, notes).
   */
  @Patch(':machineId/production-logs/:logId')
  @RequirePermissions(AppModule.MACHINES, 'machines.production.log')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('logId') logId: string,
    @Body() dto: UpdateProductionLogDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    const tz = await this.service.getWorkspaceTimezone(workspaceId);
    return this.service.update(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        workspaceTimezone: tz,
        scopedMachineIds: getScopedMachineIds(req),
      },
      machineId,
      logId,
      dto,
    );
  }

  /**
   * DELETE /workspaces/:workspaceId/machines/:machineId/production-logs/:logId
   * Soft-delete a production log (sets isDeleted + deletedAt).
   */
  @Delete(':machineId/production-logs/:logId')
  @RequirePermissions(AppModule.MACHINES, 'machines.production.log')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async softDelete(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('logId') logId: string,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    const tz = await this.service.getWorkspaceTimezone(workspaceId);
    return this.service.softDelete(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        workspaceTimezone: tz,
        scopedMachineIds: getScopedMachineIds(req),
      },
      machineId,
      logId,
    );
  }
}
