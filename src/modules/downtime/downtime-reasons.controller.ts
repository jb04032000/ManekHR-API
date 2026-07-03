import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  RolesGuard,
  RequirePermissions,
} from '../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';
import { MACHINES_P2_SUBFEATURES } from '../subscriptions/machines-plan-migration.service';
import { DowntimeReasonsService } from './downtime-reasons.service';
import { ReasonCatalogueUpdateDto } from './dto/reason-catalogue-update.dto';

const SUB_FEATURE = MACHINES_P2_SUBFEATURES.MACHINES_DOWNTIME;

/**
 * DowntimeReasonsController — workspace-scoped reason catalogue (D-08 routes 7-8).
 *
 * Routes:
 *   GET   /api/workspaces/:workspaceId/machines/downtime/reasons
 *   PATCH /api/workspaces/:workspaceId/machines/downtime/reasons
 *
 * Guard chain: JwtAuthGuard → RolesGuard → SubscriptionGuard.
 * NOTE: No row-scope guard — catalogue endpoints are workspace-scope only;
 *       owner-only access is enforced via the `machines.downtime.reasons.manage`
 *       permission gate on PATCH (D-11).
 *
 * Module wiring lives in DowntimeModule (Plan 22-04).
 */
@Controller('workspaces/:workspaceId/machines/downtime/reasons')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class DowntimeReasonsController {
  constructor(private readonly reasonsService: DowntimeReasonsService) {}

  /**
   * GET — return the workspace catalogue (lazy-seeds 7 system codes on first read).
   * Visible to anyone with `machines.downtime.view`.
   */
  @Get()
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.view')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  get(@Param('workspaceId') workspaceId: string) {
    return this.reasonsService.get(workspaceId);
  }

  /**
   * PATCH — owner-only full-replace of the catalogue.
   * Service enforces system-code immutability (key, category, presence).
   */
  @Patch()
  @RequirePermissions(AppModule.MACHINES, 'machines.downtime.reasons.manage')
  @RequireSubscription({ module: AppModule.MACHINES, subFeature: SUB_FEATURE })
  replace(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ReasonCatalogueUpdateDto,
  ) {
    return this.reasonsService.replace(workspaceId, dto);
  }
}
