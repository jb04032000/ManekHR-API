import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AttendanceDevice,
  AttendanceDeviceSchema,
} from './schemas/attendance-device.schema';
import {
  AttendanceDeviceCommand,
  AttendanceDeviceCommandSchema,
} from './schemas/attendance-device-command.schema';
import { AttendanceModule } from '../attendance/attendance.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { TeamModule } from '../team/team.module';
import { AttendanceIngestModule } from '../attendance-ingest/attendance-ingest.module';
import { AttendanceDevicesController } from './attendance-devices.controller';
import { AttendanceDevicesService } from './attendance-devices.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AttendanceDevice.name, schema: AttendanceDeviceSchema },
      { name: AttendanceDeviceCommand.name, schema: AttendanceDeviceCommandSchema },
    ]),
    // AttendanceModule exports: AttendanceEventService, AttendanceProjectionService, MongooseModule
    // MongooseModule re-export makes AttendanceEvent model injectable here.
    forwardRef(() => AttendanceModule),
    // WorkspacesModule exports: WorkspacesService, MongooseModule
    // MongooseModule re-export makes Workspace model injectable here.
    WorkspacesModule,
    // TeamModule exports: TeamService, MongooseModule
    // MongooseModule re-export makes TeamMember model injectable here.
    forwardRef(() => TeamModule),
    // forwardRef avoids circular dep between AttendanceIngestModule (imports WorkspacesModule)
    // and AttendanceDevicesModule (imports AttendanceIngestModule).
    forwardRef(() => AttendanceIngestModule),
  ],
  controllers: [AttendanceDevicesController],
  providers: [AttendanceDevicesService],
  exports: [AttendanceDevicesService],
})
export class AttendanceDevicesModule {}
