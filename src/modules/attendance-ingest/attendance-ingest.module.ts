import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AttendanceDevice,
  AttendanceDeviceSchema,
} from '../attendance-devices/schemas/attendance-device.schema';
import {
  AttendanceDeviceCommand,
  AttendanceDeviceCommandSchema,
} from '../attendance-devices/schemas/attendance-device-command.schema';
import {
  AttendanceIngestLog,
  AttendanceIngestLogSchema,
} from './schemas/attendance-ingest-log.schema';
import { AttendanceModule } from '../attendance/attendance.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { TeamModule } from '../team/team.module';
import { AttendanceIngestController } from './attendance-ingest.controller';
import { AttendanceIngestService } from './attendance-ingest.service';
import { AnomaliesModule } from '../anomalies/anomalies.module';
import { SalaryModule } from '../salary/salary.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AttendanceDevice.name, schema: AttendanceDeviceSchema },
      {
        name: AttendanceDeviceCommand.name,
        schema: AttendanceDeviceCommandSchema,
      },
      { name: AttendanceIngestLog.name, schema: AttendanceIngestLogSchema },
    ]),
    // AttendanceModule exports: AttendanceEventService, AttendanceProjectionService, MongooseModule
    // The MongooseModule export makes AttendanceEvent model injectable here.
    forwardRef(() => AttendanceModule),
    // WorkspacesModule exports: WorkspacesService, WorkspaceCounterService, MongooseModule
    // The MongooseModule export makes Workspace + WorkspaceMember models injectable here.
    WorkspacesModule,
    // TeamModule exports: TeamService, MongooseModule
    // The MongooseModule export makes TeamMember model injectable here.
    forwardRef(() => TeamModule),
    // AnomaliesModule exports: AnomaliesService — used for unknown_sn and locked_payroll_push anomalies
    forwardRef(() => AnomaliesModule),
    // SalaryModule exports MongooseModule — makes Salary model injectable for locked-payroll gate (H3-05)
    forwardRef(() => SalaryModule),
  ],
  controllers: [AttendanceIngestController],
  providers: [AttendanceIngestService],
  // Export so AttendanceDevicesModule can call evictFromCache on token rotation
  exports: [AttendanceIngestService],
})
export class AttendanceIngestModule {}
