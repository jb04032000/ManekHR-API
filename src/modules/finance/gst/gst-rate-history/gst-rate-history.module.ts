import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GstRateHistory, GstRateHistorySchema } from './gst-rate-history.schema';
import { GstRateHistoryService } from './gst-rate-history.service';
import { GstRateHistoryController } from './gst-rate-history.controller';
import { AuditModule } from '../../../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: GstRateHistory.name, schema: GstRateHistorySchema }]),
    AuditModule,
  ],
  controllers: [GstRateHistoryController],
  providers: [GstRateHistoryService],
  exports: [GstRateHistoryService, MongooseModule],
})
export class GstRateHistoryModule {}
