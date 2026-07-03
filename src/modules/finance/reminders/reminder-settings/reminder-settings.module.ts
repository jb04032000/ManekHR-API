import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReminderSettings, ReminderSettingsSchema } from './reminder-settings.schema';
import { ReminderSettingsController } from './reminder-settings.controller';
import { ReminderSettingsService } from './reminder-settings.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReminderSettings.name, schema: ReminderSettingsSchema },
    ]),
  ],
  controllers: [ReminderSettingsController],
  providers: [ReminderSettingsService],
  exports: [MongooseModule, ReminderSettingsService],
})
export class ReminderSettingsModule {}
