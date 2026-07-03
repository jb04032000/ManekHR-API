import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReminderLog, ReminderLogSchema } from './reminder-log.schema';
import { ReminderLogController } from './reminder-log.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ReminderLog.name, schema: ReminderLogSchema }]),
  ],
  controllers: [ReminderLogController],
  providers: [],
  exports: [MongooseModule],
})
export class ReminderLogModule {}
