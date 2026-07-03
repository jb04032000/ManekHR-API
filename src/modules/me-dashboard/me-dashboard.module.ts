import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MeDashboardController } from './me-dashboard.controller';
import { MeDashboardService } from './me-dashboard.service';
import {
  WorkspaceMember,
  WorkspaceMemberSchema,
} from '../workspaces/schemas/workspace-member.schema';
import { TeamMember, TeamMemberSchema } from '../team/schemas/team-member.schema';
import { Attendance, AttendanceSchema } from '../attendance/schemas/attendance.schema';
import { Salary, SalarySchema } from '../salary/schemas/salary.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      { name: TeamMember.name, schema: TeamMemberSchema },
      { name: Attendance.name, schema: AttendanceSchema },
      { name: Salary.name, schema: SalarySchema },
    ]),
  ],
  controllers: [MeDashboardController],
  providers: [MeDashboardService],
})
export class MeDashboardModule {}
