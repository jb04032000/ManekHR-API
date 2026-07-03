import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShiftsService } from './shifts.service';
import { ShiftsController } from './shifts.controller';
import { Shift, ShiftSchema } from './schemas/shift.schema';
import { TeamModule } from '../team/team.module'; // For referencing TeamMember schema
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Shift.name, schema: ShiftSchema }]),
    forwardRef(() => TeamModule),
    SubscriptionsModule,
    WorkspacesModule,
    // S2 - AuditService for shift write-op audit-event logging.
    // PostHogService is @Global, so no explicit import is needed.
    AuditModule,
  ],
  controllers: [ShiftsController],
  providers: [ShiftsService],
  exports: [ShiftsService, MongooseModule],
})
export class ShiftsModule {}
