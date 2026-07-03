import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReminderRule, ReminderRuleSchema } from './reminder-rule.schema';
import { ReminderRulesController } from './reminder-rule.controller';
import { ReminderRulesService } from './reminder-rule.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ReminderRule.name, schema: ReminderRuleSchema }]),
  ],
  controllers: [ReminderRulesController],
  providers: [ReminderRulesService],
  exports: [MongooseModule, ReminderRulesService],
})
export class ReminderRuleModule {}
