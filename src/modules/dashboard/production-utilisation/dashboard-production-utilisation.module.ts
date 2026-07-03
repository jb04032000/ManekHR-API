import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductionLogSchema } from '../../production-logs/schemas/production-log.schema';
import { DowntimeEntrySchema } from '../../downtime/schemas/downtime-entry.schema';
import { MachineSchema } from '../../machines/schemas/machine.schema';
import { WorkspaceSchema } from '../../workspaces/schemas/workspace.schema';
import { ShiftSchema } from '../../shifts/schemas/shift.schema';
import { MachineShiftAssignmentSchema } from '../../machines/schemas/machine-shift-assignment.schema';
import { LocationSchema } from '../../locations/schemas/location.schema';
import { UtilisationCacheService } from './helpers/cache';
import { ShiftClipperService } from './aggregations/shift-clipper';
import { UtilisationService } from './utilisation.service';
import { DashboardProductionUtilisationController } from './dashboard-production-utilisation.controller';

/**
 * DashboardProductionUtilisationModule (Phase 25).
 *
 * Wave 2 (25-04, this plan): module skeleton + cross-module schema
 *   registrations + UtilisationCacheService provider/export.
 *
 * Future plans:
 *   - 25-06 → KpiService (today/week/month + uptime + top machines/reasons)
 *   - 25-07 → TrendService (per-machine trend with auto-granularity)
 *   - 25-08 → HeatmapService + ExportService
 *   - 25-09 → DashboardProductionUtilisationController + permission/sub-feature gates
 *
 * Schemas are registered via string tokens (`{ name: 'X', schema: XSchema }`)
 * because Mongoose dedupes by collection name and the owning modules
 * (ProductionLogsModule, DowntimeModule, MachinesModule, WorkspacesModule,
 * ShiftsModule) keep their own forFeature registrations for their own
 * services. Downstream services in this module will inject via
 * `@InjectModel('ProductionLog')` etc. (F-16-02 STATE.md decorator-metadata
 * pattern; aligns with MaintenanceModule and DowntimeModule precedent).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'ProductionLog', schema: ProductionLogSchema },
      { name: 'DowntimeEntry', schema: DowntimeEntrySchema },
      { name: 'Machine', schema: MachineSchema },
      { name: 'Workspace', schema: WorkspaceSchema },
      { name: 'Shift', schema: ShiftSchema },
      { name: 'MachineShiftAssignment', schema: MachineShiftAssignmentSchema },
      { name: 'Location', schema: LocationSchema },
    ]),
  ],
  controllers: [DashboardProductionUtilisationController],
  providers: [UtilisationCacheService, ShiftClipperService, UtilisationService],
  exports: [UtilisationCacheService, ShiftClipperService, UtilisationService],
})
export class DashboardProductionUtilisationModule {}
