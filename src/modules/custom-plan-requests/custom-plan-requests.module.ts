import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomPlanRequest, CustomPlanRequestSchema } from './schemas/custom-plan-request.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { AuditModule } from '../audit/audit.module';
import {
  AdminCustomPlanRequestsController,
  CustomPlanRequestsController,
} from './custom-plan-requests.controller';
import { CustomPlanRequestsService } from './custom-plan-requests.service';

/**
 * Custom Plan Requests -- self-contained lead-capture module (dedicated, like the
 * Connect institutes/candidate-request module, so it never touches the @Global
 * SubscriptionsModule import graph). PostHogService is @Global so it needs no
 * import; AuditModule is imported for the write seam.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CustomPlanRequest.name, schema: CustomPlanRequestSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AuditModule,
  ],
  controllers: [CustomPlanRequestsController, AdminCustomPlanRequestsController],
  providers: [CustomPlanRequestsService],
})
export class CustomPlanRequestsModule {}
