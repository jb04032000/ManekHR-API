import { Module, forwardRef } from '@nestjs/common';
import { AttendanceImportController } from './attendance-import.controller';
import { AttendanceImportService } from './attendance-import.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { TeamModule } from '../team/team.module';
import { SalaryModule } from '../salary/salary.module';

@Module({
  imports: [
    forwardRef(() => AttendanceModule), // provides AttendanceProjectionService + AttendanceEvent model via MongooseModule export
    forwardRef(() => TeamModule), // provides TeamMember model for member lookup in commit (F-04)
    forwardRef(() => SalaryModule), // provides Salary model for locked-payroll gate (H3-05, GAP-2.3-A)
  ],
  controllers: [AttendanceImportController],
  providers: [AttendanceImportService],
})
export class AttendanceImportModule {}
