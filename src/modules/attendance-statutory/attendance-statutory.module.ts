import { Module, forwardRef } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { TeamModule } from '../team/team.module';
import { SalaryModule } from '../salary/salary.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AttendanceStatutoryController } from './attendance-statutory.controller';
import { AttendanceStatutoryService } from './attendance-statutory.service';
import { StatutoryDataService } from './services/statutory-data.service';
import { OtRateResolver } from './services/ot-rate-resolver.service';

@Module({
  imports: [
    forwardRef(() => AttendanceModule),    // exports Attendance + AttendanceEvent models (MongooseModule)
    forwardRef(() => TeamModule),          // exports TeamMember model
    forwardRef(() => SalaryModule),        // exports Salary model (MongooseModule)
    forwardRef(() => ShiftsModule),        // exports Shift model
    WorkspacesModule,    // exports Workspace model
    SubscriptionsModule, // subscription resolver for the guard
  ],
  controllers: [AttendanceStatutoryController],
  providers: [
    AttendanceStatutoryService,
    StatutoryDataService,
    OtRateResolver,
  ],
})
export class AttendanceStatutoryModule {}
