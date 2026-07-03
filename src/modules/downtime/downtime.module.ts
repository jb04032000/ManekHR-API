import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DowntimeEntry,
  DowntimeEntrySchema,
} from './schemas/downtime-entry.schema';
import {
  WorkspaceDowntimeReasonConfig,
  WorkspaceDowntimeReasonConfigSchema,
} from './schemas/downtime-reason-config.schema';
import { DowntimeReasonsService } from './downtime-reasons.service';
import { DowntimeReasonsController } from './downtime-reasons.controller';
import { DowntimeController } from './downtime.controller';
import { DowntimeService } from './downtime.service';
import { MachinesModule } from '../machines/machines.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SalaryModule } from '../salary/salary.module';

// NOTE: ResourceScopesModule is @Global() and registered in AppModule — its
// ResourceScopeGuard + ResourceScopesService are available globally without
// importing ResourceScopesModule here.
//
// NOTE: DowntimeService + DowntimeController land in Plans 22-06 / 22-07.
// They will edit this module to add themselves; for now only the catalogue
// surface from Plan 22-03 is wired.
//
// NOTE: Plan 22-05 will register DowntimeEntrySchema in MachinesModule
// (so MachinesService.recomputeStatus can inject the model). Mongoose
// dedupes the collection — verified by F-10-05 STATE.md decision.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DowntimeEntry.name, schema: DowntimeEntrySchema },
      {
        name: WorkspaceDowntimeReasonConfig.name,
        schema: WorkspaceDowntimeReasonConfigSchema,
      },
    ]),
    MachinesModule,
    WorkspacesModule,
    SubscriptionsModule,
    SalaryModule,
  ],
  controllers: [DowntimeReasonsController, DowntimeController],
  providers: [DowntimeReasonsService, DowntimeService],
  exports: [
    DowntimeReasonsService,
    DowntimeService,
    // Re-export the model registration so other modules (Plans 22-05/06)
    // can also register the DowntimeEntry schema via forFeature without
    // circular import (Mongoose dedupes per F-10-05 STATE.md decision).
    MongooseModule,
  ],
})
export class DowntimeModule {}
