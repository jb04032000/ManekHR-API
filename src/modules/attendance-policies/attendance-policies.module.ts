import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AttendancePolicy, AttendancePolicySchema } from './schemas/attendance-policy.schema';
import { AttendancePoliciesService } from './attendance-policies.service';
import { AttendancePoliciesController } from './attendance-policies.controller';
import { AttendanceModule } from '../attendance/attendance.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: AttendancePolicy.name, schema: AttendancePolicySchema }]),
    forwardRef(() => AttendanceModule), // grants access to Attendance + AttendanceEvent + Shift + TeamMember models for dry-run
    AuditModule,
  ],
  controllers: [AttendancePoliciesController],
  providers: [AttendancePoliciesService],
  exports: [AttendancePoliciesService, MongooseModule],
})
export class AttendancePoliciesModule {}
