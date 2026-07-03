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
import { DowntimeService } from './downtime.service';
import { CreateDowntimeDto } from './dto/create-downtime.dto';
import { UpdateDowntimeDto } from './dto/update-downtime.dto';
import { CloseDowntimeDto } from './dto/close-downtime.dto';
import { ListDowntimeQueryDto } from './dto/list-downtime.query.dto';

const SUB_FEATURE = MACHINES_P2_SUBFEATURES.MACHINES_DOWNTIME;

/**
 * DowntimeController — thin HTTP layer over DowntimeService (D-08).
 *
 * Guard chain: JwtAuthGuard → RolesGuard → ResourceScopeGuard → SubscriptionGuard
 *
 * Route ordering invariant (NestJS resolves in declaration order):
 *   1. STATIC workspace routes first:
 *        GET  downtime/peek-next-code     (before any /downtime/:something)
 *        GET  downtime                    (workspace-list)
 *   2. Machine-scoped routes (`:machineId/downtime/...`):
 *        GET    :machineId/downtime              (list)
 *        GET    :machineId/downtime/active       (STATIC — must precede :entryId)
 *        POST   :machineId/downtime              (create)
 *        PATCH  :machineId/downtime/:entryId/close   (STATIC '/close' — must precede bare :entryId)
 *        PATCH  :machineId/downtime/:entryId         (update)
 *        DELETE :machineId/downtime/:entryId         (soft-delete)
 *
 * Per-route `assertMachineInScope` enforces ResourceScope row-filter on
 * machine-scoped paths (MACH-P2-XC-04). Reason catalogue endpoints live
 * in DowntimeReasonsController and are NOT duplicated here.
 */
@Controller('workspaces/:workspaceId/machines')
@UseGuards(JwtAuthGuard, RolesGuard, ResourceScopeGuard, SubscriptionGuard)
export class DowntimeController {
  constructor(private readonly service: DowntimeService) {}

  // ============================================================
  // STATIC WORKSPACE ROUTES — declared first to avoid Pitfall 2
  // ============================================================

  /**
   * GET /workspaces/:workspaceId/machines/downtime/peek-next-code
   * Preview the next DT-NNN code without reserving it.
   */
  @Get('downtime/peek-next-code')
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.view')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  peekNextCode(@Param('workspaceId') workspaceId: string) {
    return this.service.peekNextCode(workspaceId);
  }

  /**
   * GET /workspaces/:workspaceId/machines/downtime
   * List downtime entries across the workspace, scoped to caller's machine scope.
   */
  @Get('downtime')
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.view')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async listWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListDowntimeQueryDto,
    @Req() req: Request,
  ) {
    return this.service.list(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        scopedMachineIds: getScopedMachineIds(req),
      },
      query,
    );
  }

  // ============================================================
  // MACHINE-SCOPED ROUTES
  // ============================================================

  /**
   * GET /workspaces/:workspaceId/machines/:machineId/downtime
   * List downtime entries for a specific machine (scope-gated).
   */
  @Get(':machineId/downtime')
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.view')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async listForMachine(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Query() query: ListDowntimeQueryDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    return this.service.list(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        scopedMachineIds: getScopedMachineIds(req),
      },
      query,
      machineId,
    );
  }

  /**
   * GET /workspaces/:workspaceId/machines/:machineId/downtime/active
   * Return the currently-open downtime entry (or null) for the machine.
   * STATIC '/active' segment — declared BEFORE dynamic ':entryId' routes.
   */
  @Get(':machineId/downtime/active')
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.view')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async getActive(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    return this.service.getActive(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        scopedMachineIds: getScopedMachineIds(req),
      },
      machineId,
    );
  }

  /**
   * POST /workspaces/:workspaceId/machines/:machineId/downtime
   * Create a downtime entry (open or closed).
   */
  @Post(':machineId/downtime')
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.log')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async create(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Body() dto: CreateDowntimeDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    return this.service.create(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        scopedMachineIds: getScopedMachineIds(req),
      },
      machineId,
      dto,
    );
  }

  /**
   * PATCH /workspaces/:workspaceId/machines/:machineId/downtime/:entryId/close
   * Close an open downtime entry. STATIC '/close' segment — declared BEFORE
   * the bare ':entryId' patch route.
   */
  @Patch(':machineId/downtime/:entryId/close')
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.log')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async close(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('entryId') entryId: string,
    @Body() dto: CloseDowntimeDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    return this.service.close(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        scopedMachineIds: getScopedMachineIds(req),
      },
      machineId,
      entryId,
      dto,
    );
  }

  /**
   * PATCH /workspaces/:workspaceId/machines/:machineId/downtime/:entryId
   * Update mutable fields on an entry (within edit window).
   */
  @Patch(':machineId/downtime/:entryId')
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.log')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('entryId') entryId: string,
    @Body() dto: UpdateDowntimeDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    return this.service.update(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        scopedMachineIds: getScopedMachineIds(req),
      },
      machineId,
      entryId,
      dto,
    );
  }

  /**
   * DELETE /workspaces/:workspaceId/machines/:machineId/downtime/:entryId
   * Soft-delete a downtime entry (releases open-downtime slot).
   */
  @Delete(':machineId/downtime/:entryId')
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.log')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async softDelete(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('entryId') entryId: string,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    return this.service.softDelete(
      {
        workspaceId,
        userId: (req.user as any)?.sub,
        scopedMachineIds: getScopedMachineIds(req),
      },
      machineId,
      entryId,
    );
  }
}
