import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReminderTemplate, ReminderTemplateSchema } from './reminder-template.schema';
import { ReminderTemplatesController } from './reminder-template.controller';
import { ReminderTemplatesService } from './reminder-template.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReminderTemplate.name, schema: ReminderTemplateSchema },
    ]),
  ],
  controllers: [ReminderTemplatesController],
  providers: [ReminderTemplatesService],
  exports: [MongooseModule, ReminderTemplatesService],
})
export class ReminderTemplateModule {}
