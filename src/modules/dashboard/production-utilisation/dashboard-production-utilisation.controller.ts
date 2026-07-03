/**
 * DashboardProductionUtilisationController — Phase 25 Plan 09 HTTP surface (D-16/D-17).
 *
 * Guard chain (class-level, mirrors Phase 22/24 precedent):
 *   JwtAuthGuard → RolesGuard → ResourceScopeGuard → SubscriptionGuard
 *
 * Authorisation gates (per-route to allow per-method clarity matching Phase 22):
 *   - @RequirePermissions(MACHINES, 'dashboard.production.view')
 *   - @RequireSubscription({ module: MACHINES, subFeature: PRODUCTION_UTILISATION_DASHBOARD })
 *
 * Static-before-dynamic ordering invariant (NestJS resolves in declaration
 * order — first matching route wins; Pitfall 2 from Phase 22 / 24):
 *   1. STATIC routes first:
 *        GET dashboard/production-utilisation/kpis
 *        GET dashboard/production-utilisation/heatmap
 *        GET dashboard/production-utilisation/export
 *   2. DYNAMIC route last:
 *        GET dashboard/production-utilisation/:machineId/trend
 *
 * Response wrapping: bare service results are returned. The global
 * `ResponseInterceptor` wraps every payload into `{ success, data }` and
 * passes pre-wrapped envelopes through unchanged (mirrors DowntimeController
 * convention — no manual wrap inside handlers).
 *
 * Defence-in-depth (T-25-09-04 / T-25-09-05): controller derives the
 * effective ResourceScope from `req.resourceScope` via `extractScope(req)`
 * — NEVER from request body or query — and the service layer re-asserts
 * any client-supplied machineIds belong to the workspace + caller scope
 * via `assertWorkspaceMachines`.
 */
import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';

import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import {
  RolesGuard,
  RequirePermissions,
} from '../../../common/guards/roles.guard';
import { ResourceScopeGuard } from '../../../common/guards/resource-scope.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../common/guards/subscription.guard';
import { AppModule } from '../../../common/enums/modules.enum';
import { MACHINES_P2_SUBFEATURES } from '../../subscriptions/machines-plan-migration.service';

import { UtilisationService, UtilCtx } from './utilisation.service';
import { extractScope } from './helpers/scope';
import { KpiQueryDto } from './dto/kpi-query.dto';
import { TrendQueryDto } from './dto/trend-query.dto';
import { HeatmapQueryDto } from './dto/heatmap-query.dto';
import { ExportQueryDto } from './dto/export-query.dto';

const SUB_FEATURE = MACHINES_P2_SUBFEATURES.PRODUCTION_UTILISATION_DASHBOARD;
const PERM_VIEW = 'dashboard.production.view';

@Controller('workspaces/:workspaceId/dashboard/production-utilisation')
@UseGuards(JwtAuthGuard, RolesGuard, ResourceScopeGuard, SubscriptionGuard)
export class DashboardProductionUtilisationController {
  constructor(private readonly utilisationService: UtilisationService) {}

  // ============================================================
  // STATIC ROUTES — declared BEFORE dynamic /:machineId/trend
  // ============================================================

  /**
   * GET /api/workspaces/:workspaceId/dashboard/production-utilisation/kpis
   * Six KPI cards (D-08). Cache-aware on the service side (5-min LRU).
   */
  @Get('kpis')
  @RequirePermissions(AppModule.MACHINES, PERM_VIEW as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async getKpis(
    @Param('workspaceId') workspaceId: string,
    @Query() q: KpiQueryDto,
    @Req() req: Request,
  ) {
    const scope = extractScope(req);
    const tz = await this.utilisationService.getWorkspaceTz(workspaceId);
    const ctx: UtilCtx = {
      workspaceId,
      scopedMachineIds: scope.scopedMachineIds,
      scopeFingerprint: scope.scopeFingerprint,
      tz,
      requestedMachineIds: q.machineIds,
      requestedLocationIds: q.locationIds,
      requestedShiftIds: q.shiftIds,
    };
    return this.utilisationService.getKpis(ctx, q.from, q.to);
  }

  /**
   * GET /api/workspaces/:workspaceId/dashboard/production-utilisation/heatmap
   * Per-location calendar grid (D-12 / D-13). Bounded to one calendar month.
   */
  @Get('heatmap')
  @RequirePermissions(AppModule.MACHINES, PERM_VIEW as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async getHeatmap(
    @Param('workspaceId') workspaceId: string,
    @Query() q: HeatmapQueryDto,
    @Req() req: Request,
  ) {
    const scope = extractScope(req);
    const tz = await this.utilisationService.getWorkspaceTz(workspaceId);
    const ctx: UtilCtx = {
      workspaceId,
      scopedMachineIds: scope.scopedMachineIds,
      scopeFingerprint: scope.scopeFingerprint,
      tz,
      requestedShiftIds: q.shiftIds,
    };
    return this.utilisationService.getHeatmap(ctx, q.locationId, q.month);
  }

  /**
   * GET /api/workspaces/:workspaceId/dashboard/production-utilisation/export
   * Flat per-machine rows for the F-14 export pipeline (D-18 / D-20).
   * Server re-derives ResourceScope (NEVER from client body) — D-20.
   */
  @Get('export')
  @RequirePermissions(AppModule.MACHINES, PERM_VIEW as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async getExport(
    @Param('workspaceId') workspaceId: string,
    @Query() q: ExportQueryDto,
    @Req() req: Request,
  ) {
    // SECURITY (D-20): scope is server-derived from JWT via extractScope(req).
    // q.machineIds is allowed for filtering but cross-checked by
    // assertWorkspaceMachines inside the service.
    const scope = extractScope(req);
    const tz = await this.utilisationService.getWorkspaceTz(workspaceId);
    const ctx: UtilCtx = {
      workspaceId,
      scopedMachineIds: scope.scopedMachineIds,
      scopeFingerprint: scope.scopeFingerprint,
      tz,
      requestedMachineIds: q.machineIds,
      requestedLocationIds: q.locationIds,
      requestedShiftIds: q.shiftIds,
    };
    return this.utilisationService.getExportRows(ctx, q.from, q.to);
  }

  // ============================================================
  // DYNAMIC ROUTE — declared LAST
  // ============================================================

  /**
   * GET /api/workspaces/:workspaceId/dashboard/production-utilisation/:machineId/trend
   * Per-machine output + uptime trend (D-10 / D-11). Auto-granularity.
   */
  @Get(':machineId/trend')
  @RequirePermissions(AppModule.MACHINES, PERM_VIEW as any)
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  async getTrend(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Query() q: TrendQueryDto,
    @Req() req: Request,
  ) {
    const scope = extractScope(req);
    const tz = await this.utilisationService.getWorkspaceTz(workspaceId);
    const ctx: UtilCtx = {
      workspaceId,
      scopedMachineIds: scope.scopedMachineIds,
      scopeFingerprint: scope.scopeFingerprint,
      tz,
      requestedShiftIds: q.shiftIds,
    };
    return this.utilisationService.getTrend(ctx, machineId, q.from, q.to);
  }
}
