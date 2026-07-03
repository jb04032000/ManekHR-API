/**
 * MaintenanceController â€” Phase 24 HTTP surface (D-08).
 *
 * Guard chain (class-level):
 *   JwtAuthGuard â†’ RolesGuard â†’ ResourceScopeGuard â†’ SubscriptionGuard
 *
 * Sub-feature gate (class-level):
 *   @RequireSubscription({ module: MACHINES, subFeature: 'machines_maintenance' })
 *
 * R5 â€” OR-permission strategy for READ routes
 * --------------------------------------------------------------------
 * Schedule + service-log read routes (GET schedules, GET schedule:id,
 * GET service-logs, GET service-log:id, GET maintenance/due) accept
 * EITHER `machines.maintenance.schedule` OR `machines.maintenance.log`.
 *
 * Investigated approaches:
 *   1. Duplicate handlers, one per @RequirePermissions â€” REJECTED.
 *      `@RequirePermissions` uses `SetMetadata` which OVERWRITES on
 *      repeated decoration; `RolesGuard` reads a SINGLE permission
 *      via `reflector.get` (not `getAll`). Two physical handlers with
 *      the same path also collide in NestJS routing â€” only one
 *      handler is mounted, so the request never falls through to a
 *      second handler with a different perm.
 *   2. Single handler + inline OR-permission check â€” ACCEPTED. Read
 *      handlers omit `@RequirePermissions` (so RolesGuard short-
 *      circuits as "no requirement â†’ allow") and instead delegate to
 *      `assertHasAnyMaintenancePermission(req)` which loads the
 *      caller's role via the same lookup RolesGuard uses (owner
 *      bypass first, then membership â†’ role â†’ permissions[]) and
 *      throws ForbiddenException unless the role grants either of
 *      the two read perms. This keeps the auth surface auditable
 *      without inventing a new decorator.
 *
 * Static-before-dynamic ordering invariant (NestJS resolves in
 * declaration order â€” the FIRST matching route wins):
 *   1. Workspace-scope statics first:
 *        GET    maintenance/due
 *        GET    maintenance/lead-time
 *        PATCH  maintenance/lead-time
 *   2. Machine-scoped collection routes:
 *        POST   :machineId/maintenance/schedules
 *        GET    :machineId/maintenance/schedules
 *        POST   :machineId/maintenance/service-logs
 *        GET    :machineId/maintenance/service-logs
 *   3. Machine-scoped statics with explicit segment BEFORE bare :id:
 *        PATCH  :machineId/maintenance/schedules/:id/pause
 *   4. Machine-scoped dynamic :id routes last:
 *        GET    :machineId/maintenance/schedules/:id
 *        PATCH  :machineId/maintenance/schedules/:id
 *        DELETE :machineId/maintenance/schedules/:id
 *        GET    :machineId/maintenance/service-logs/:id
 *        PATCH  :machineId/maintenance/service-logs/:id
 *
 * NOTE: Service-logs do NOT support DELETE â€” service history is
 * permanent (D-15). Only POST / GET / GET:id / PATCH (7-day window).
 */
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { Request } from 'express';
// Side-effect import: registers Express.Request.user typing.
import '../../common/types/express-request.augmentation';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import {
  ResourceScopeGuard,
  assertMachineInScope,
  getScopedMachineIds,
} from '../../common/guards/resource-scope.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';
import { MACHINES_P2_SUBFEATURES } from '../subscriptions/machines-plan-migration.service';
import { isWorkspaceOwner } from '../../common/utils/workspace-ownership.util';

import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { ServiceLogsService } from './service-logs.service';
import { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';
import { UpdateMaintenanceScheduleDto } from './dto/update-maintenance-schedule.dto';
import { PauseScheduleDto } from './dto/pause-schedule.dto';
import { SetMaintenanceLeadTimeDto } from './dto/set-maintenance-lead-time.dto';
import { CreateServiceLogDto } from './dto/create-service-log.dto';
import { UpdateServiceLogDto } from './dto/update-service-log.dto';
import { ListServiceLogsQueryDto } from './dto/list-service-logs.query.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

const SUB_FEATURE = MACHINES_P2_SUBFEATURES.MACHINES_MAINTENANCE;
const PERM_SCHEDULE = 'machines.maintenance.schedule';
const PERM_LOG = 'machines.maintenance.log';
const READ_PERMS = [PERM_SCHEDULE, PERM_LOG] as const;

@LegacyUnclassified()
@Controller('workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, RolesGuard, ResourceScopeGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
export class MaintenanceController {
  constructor(
    private readonly schedulesService: MaintenanceSchedulesService,
    private readonly logsService: ServiceLogsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ============================================================
  // R5 â€” Inline OR-permission check for READ routes.
  // Mirrors RolesGuard's lookup chain: owner bypass â†’ membership â†’
  // role.permissions. Throws ForbiddenException when neither
  // schedule nor log perm is granted on the MACHINES module.
  // ============================================================
  private async assertHasAnyMaintenancePermission(
    req: Request,
    workspaceId: string,
  ): Promise<void> {
    const user = req.user;
    if (!user?.sub) {
      throw new ForbiddenException('Authentication required for maintenance read.');
    }

    interface WorkspaceForOwnerCheck {
      ownerId?: mongoose.Types.ObjectId | string;
    }
    interface MembershipRow {
      roleId?: mongoose.Types.ObjectId | string | { toString(): string };
      status: string;
    }
    interface PermissionRow {
      module: string;
      actions: string[];
    }
    interface RoleRow {
      permissions?: PermissionRow[];
    }

    const workspaceModel = this.moduleRef.get<Model<WorkspaceForOwnerCheck>>(
      getModelToken('Workspace'),
      { strict: false },
    );
    const memberModel = this.moduleRef.get<Model<MembershipRow>>(getModelToken('WorkspaceMember'), {
      strict: false,
    });
    const roleModel = this.moduleRef.get<Model<RoleRow>>(getModelToken('Role'), {
      strict: false,
    });

    const workspace = await workspaceModel.findById(workspaceId).exec();
    if (!workspace) {
      throw new ForbiddenException('Workspace not found');
    }
    // Owner bypass â€” RolesGuard does the same.
    if (isWorkspaceOwner(workspace, user.sub)) return;

    const member = await memberModel
      .findOne({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        userId: new mongoose.Types.ObjectId(user.sub),
        status: 'active',
      })
      .exec();
    if (!member?.roleId) {
      throw new ForbiddenException('You do not have permission for this action');
    }

    const role = await roleModel.findById(member.roleId.toString()).exec();
    if (!role) {
      throw new ForbiddenException('Your assigned role no longer exists');
    }

    const granted = (role.permissions ?? []).some(
      (p) =>
        p.module === (AppModule.MACHINES as string) &&
        Array.isArray(p.actions) &&
        p.actions.some((a: string) => (READ_PERMS as readonly string[]).includes(a)),
    );
    if (!granted) {
      throw new ForbiddenException('You do not have permission for this action');
    }
  }

  // ============================================================
  // STATIC WORKSPACE-SCOPE ROUTES (declared first)
  // ============================================================

  /**
   * GET /api/workspaces/:workspaceId/maintenance/due
   * Schedules due within their effective lead-time across the workspace,
   * narrowed to caller's scoped machines (MACH-P2-XC-04). OR-perm read.
   */
  @Get('maintenance/due')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async listDue(
    @Param('workspaceId') workspaceId: string,
    @Query() query: { limit?: string; offset?: string } | undefined,
    @Req() req: Request,
  ) {
    await this.assertHasAnyMaintenancePermission(req, workspaceId);
    const limit = parseInt(query?.limit ?? '', 10);
    const offset = parseInt(query?.offset ?? '', 10);
    const result = await this.schedulesService.listDue(
      {
        workspaceId,
        userId: req.user?.sub,
        scopedMachineIds: getScopedMachineIds(req),
      },
      {
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      },
    );
    return { success: true, data: result };
  }

  /**
   * GET /api/workspaces/:workspaceId/maintenance/lead-time
   * Workspace default lead-time (D-10). Read perm: schedule (settings).
   */
  @Get('maintenance/lead-time')
  @RequirePermissions(AppModule.MACHINES, PERM_SCHEDULE as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async getLeadTime(@Param('workspaceId') workspaceId: string) {
    const result = await this.schedulesService.getLeadTime(workspaceId);
    return { success: true, data: result };
  }

  /**
   * PATCH /api/workspaces/:workspaceId/maintenance/lead-time
   * Owner-only setter (gated by PERM_SCHEDULE; only owners + roles with
   * machines.maintenance.schedule pass).
   */
  @Patch('maintenance/lead-time')
  @RequirePermissions(AppModule.MACHINES, PERM_SCHEDULE as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async setLeadTime(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SetMaintenanceLeadTimeDto,
  ) {
    const result = await this.schedulesService.setLeadTime(workspaceId, dto);
    return { success: true, data: result };
  }

  // ============================================================
  // MACHINE-SCOPED COLLECTION ROUTES
  // ============================================================

  /**
   * POST /api/workspaces/:workspaceId/machines/:machineId/maintenance/schedules
   * Create a maintenance schedule for a machine.
   */
  @Post('machines/:machineId/maintenance/schedules')
  @RequirePermissions(AppModule.MACHINES, PERM_SCHEDULE as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async createSchedule(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Body() dto: CreateMaintenanceScheduleDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    const result = await this.schedulesService.create(
      { workspaceId, userId: req.user?.sub },
      machineId,
      dto,
    );
    return { success: true, data: result };
  }

  /**
   * GET /api/workspaces/:workspaceId/machines/:machineId/maintenance/schedules
   * List schedules for a machine. OR-perm read.
   */
  @Get('machines/:machineId/maintenance/schedules')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async listSchedules(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Req() req: Request,
  ) {
    await this.assertHasAnyMaintenancePermission(req, workspaceId);
    assertMachineInScope(req, machineId);
    const result = await this.schedulesService.list(
      { workspaceId, userId: req.user?.sub },
      machineId,
    );
    return { success: true, data: result };
  }

  /**
   * POST /api/workspaces/:workspaceId/machines/:machineId/maintenance/service-logs
   * Create a service log (auto-creates linked downtime entry).
   */
  @Post('machines/:machineId/maintenance/service-logs')
  @RequirePermissions(AppModule.MACHINES, PERM_LOG as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async createServiceLog(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Body() dto: CreateServiceLogDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    const result = await this.logsService.create(
      { workspaceId, userId: req.user?.sub },
      machineId,
      dto,
    );
    return { success: true, data: result };
  }

  /**
   * GET /api/workspaces/:workspaceId/machines/:machineId/maintenance/service-logs
   * List service logs for a machine. OR-perm read.
   */
  @Get('machines/:machineId/maintenance/service-logs')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async listServiceLogs(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Query() query: ListServiceLogsQueryDto,
    @Req() req: Request,
  ) {
    await this.assertHasAnyMaintenancePermission(req, workspaceId);
    assertMachineInScope(req, machineId);
    const result = await this.logsService.list(
      { workspaceId, userId: req.user?.sub },
      machineId,
      query,
    );
    return { success: true, data: result };
  }

  // ============================================================
  // MACHINE-SCOPED STATIC SEGMENT ROUTES (before bare :id)
  // ============================================================

  /**
   * PATCH /api/workspaces/:workspaceId/machines/:machineId/maintenance/schedules/:id/pause
   * Pause / resume a schedule. Static '/pause' MUST precede bare ':id' patch.
   */
  @Patch('machines/:machineId/maintenance/schedules/:id/pause')
  @RequirePermissions(AppModule.MACHINES, PERM_SCHEDULE as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async pauseSchedule(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('id') scheduleId: string,
    @Body() dto: PauseScheduleDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    const result = await this.schedulesService.pause(
      { workspaceId, userId: req.user?.sub },
      machineId,
      scheduleId,
      dto,
    );
    return { success: true, data: result };
  }

  // ============================================================
  // MACHINE-SCOPED DYNAMIC :id ROUTES (declared LAST)
  // ============================================================

  /**
   * GET /api/workspaces/:workspaceId/machines/:machineId/maintenance/schedules/:id
   * Single schedule. OR-perm read.
   */
  @Get('machines/:machineId/maintenance/schedules/:id')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async getSchedule(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('id') scheduleId: string,
    @Req() req: Request,
  ) {
    await this.assertHasAnyMaintenancePermission(req, workspaceId);
    assertMachineInScope(req, machineId);
    const result = await this.schedulesService.get(
      { workspaceId, userId: req.user?.sub },
      machineId,
      scheduleId,
    );
    return { success: true, data: result };
  }

  /**
   * PATCH /api/workspaces/:workspaceId/machines/:machineId/maintenance/schedules/:id
   * Update schedule fields (recomputes nextDueAt on cadence touch).
   */
  @Patch('machines/:machineId/maintenance/schedules/:id')
  @RequirePermissions(AppModule.MACHINES, PERM_SCHEDULE as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async updateSchedule(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('id') scheduleId: string,
    @Body() dto: UpdateMaintenanceScheduleDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    const result = await this.schedulesService.update(
      { workspaceId, userId: req.user?.sub },
      machineId,
      scheduleId,
      dto,
    );
    return { success: true, data: result };
  }

  /**
   * DELETE /api/workspaces/:workspaceId/machines/:machineId/maintenance/schedules/:id
   * Soft-delete a schedule (history preserved, hidden from reads).
   */
  @Delete('machines/:machineId/maintenance/schedules/:id')
  @RequirePermissions(AppModule.MACHINES, PERM_SCHEDULE as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async deleteSchedule(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('id') scheduleId: string,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    const result = await this.schedulesService.softDelete(
      { workspaceId, userId: req.user?.sub },
      machineId,
      scheduleId,
    );
    return { success: true, data: result };
  }

  /**
   * GET /api/workspaces/:workspaceId/machines/:machineId/maintenance/service-logs/:id
   * Single service log. OR-perm read.
   */
  @Get('machines/:machineId/maintenance/service-logs/:id')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async getServiceLog(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('id') logId: string,
    @Req() req: Request,
  ) {
    await this.assertHasAnyMaintenancePermission(req, workspaceId);
    assertMachineInScope(req, machineId);
    const result = await this.logsService.get(
      { workspaceId, userId: req.user?.sub },
      machineId,
      logId,
    );
    return { success: true, data: result };
  }

  /**
   * PATCH /api/workspaces/:workspaceId/machines/:machineId/maintenance/service-logs/:id
   * Patch notes / costPaise within 7-day window (D-15). NO DELETE â€” history is permanent.
   */
  @Patch('machines/:machineId/maintenance/service-logs/:id')
  @RequirePermissions(AppModule.MACHINES, PERM_LOG as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async updateServiceLog(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('id') logId: string,
    @Body() dto: UpdateServiceLogDto,
    @Req() req: Request,
  ) {
    assertMachineInScope(req, machineId);
    const result = await this.logsService.update(
      { workspaceId, userId: req.user?.sub },
      machineId,
      logId,
      dto,
    );
    return { success: true, data: result };
  }
}
