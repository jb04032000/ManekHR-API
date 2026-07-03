import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HolidaysService } from './holidays.service';
import { HolidaysController } from './holidays.controller';
import { Holiday, HolidaySchema } from './schemas/holiday.schema';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Holiday.name, schema: HolidaySchema }]),
    SubscriptionsModule,
    WorkspacesModule,
    // H2 - AuditService for holiday write-op audit-event logging.
    // PostHogService is @Global, so no explicit import is needed.
    AuditModule,
  ],
  controllers: [HolidaysController],
  providers: [HolidaysService],
  exports: [HolidaysService, MongooseModule],
})
export class HolidaysModule {}
