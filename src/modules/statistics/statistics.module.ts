import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StatisticsService } from './statistics.service';
import { HrOverviewService } from './hr-overview.service';
import { StatisticsController } from './statistics.controller';
import {
  Attendance,
  AttendanceSchema,
} from '../attendance/schemas/attendance.schema';
import { Salary, SalarySchema } from '../salary/schemas/salary.schema';
import { Payment, PaymentSchema } from '../salary/schemas/payment.schema';
import {
  TeamMember,
  TeamMemberSchema,
} from '../team/schemas/team-member.schema';
// Shift model — the updated ERP's StatisticsService now needs it ("workforce by shift").
import { Shift, ShiftSchema } from '../shifts/schemas/shift.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Attendance.name, schema: AttendanceSchema },
      { name: Salary.name, schema: SalarySchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: TeamMember.name, schema: TeamMemberSchema },
      { name: Shift.name, schema: ShiftSchema },
    ]),
  ],
  controllers: [StatisticsController],
  // HrOverviewService injects the @Global SubscriptionsService (no extra import
  // needed) for the per-workspace SALARY module gate.
  providers: [StatisticsService, HrOverviewService],
  exports: [StatisticsService, HrOverviewService],
})
export class StatisticsModule {}
