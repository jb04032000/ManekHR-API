import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MachinesService } from './machines.service';
import { MachinesController } from './machines.controller';
import { Machine, MachineSchema } from './schemas/machine.schema';
import {
  MachineShiftAssignment,
  MachineShiftAssignmentSchema,
} from './schemas/machine-shift-assignment.schema';
import {
  DowntimeEntry,
  DowntimeEntrySchema,
} from '../downtime/schemas/downtime-entry.schema';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { LocationsModule } from '../locations/locations.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { TeamModule } from '../team/team.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Machine.name, schema: MachineSchema },
      {
        name: MachineShiftAssignment.name,
        schema: MachineShiftAssignmentSchema,
      },
      // Dedupe pattern (F-10-05 precedent, STATE.md line 70): DowntimeModule
      // also registers this schema. Mongoose deduplicates per collection so
      // both modules' @InjectModel(DowntimeEntry.name) resolve to the same
      // model — no circular import on DowntimeModule needed.
      { name: DowntimeEntry.name, schema: DowntimeEntrySchema },
    ]),
    WorkspacesModule,
    LocationsModule,
    SubscriptionsModule,
    forwardRef(() => TeamModule),
  ],
  controllers: [MachinesController],
  providers: [MachinesService],
  exports: [MachinesService, MongooseModule],
})
export class MachinesModule {}
