import { Module } from '@nestjs/common';
import { ReminderRuleModule } from './reminder-rule/reminder-rule.module';
import { ReminderLogModule } from './reminder-log/reminder-log.module';
import { ReminderTemplateModule } from './reminder-template/reminder-template.module';
import { ReminderSettingsModule } from './reminder-settings/reminder-settings.module';
import { CallTodoModule } from './call-todo/call-todo.module';

@Module({
  imports: [
    ReminderRuleModule,
    ReminderLogModule,
    ReminderTemplateModule,
    ReminderSettingsModule,
    CallTodoModule,
  ],
  exports: [
    ReminderRuleModule,
    ReminderLogModule,
    ReminderTemplateModule,
    ReminderSettingsModule,
    CallTodoModule,
  ],
})
export class RemindersModule {}
