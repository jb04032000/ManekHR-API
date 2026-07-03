import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReminderDispatcherCron } from './reminder-dispatcher.cron';
import { ReminderDispatcherService } from './reminder-dispatcher.service';
import { ReminderDispatcherController } from './reminder-dispatcher.controller';
import { ReminderRule, ReminderRuleSchema } from '../reminder-rule/reminder-rule.schema';
import { ReminderLog, ReminderLogSchema } from '../reminder-log/reminder-log.schema';
import { ReminderSettings, ReminderSettingsSchema } from '../reminder-settings/reminder-settings.schema';
import { ReminderRuleModule } from '../reminder-rule/reminder-rule.module';
import { CallTodoModule } from '../call-todo/call-todo.module';
import { AdaptersModule } from '../adapters/adapters.module';
import { SaleInvoice, SaleInvoiceSchema } from '../../sales/sale-invoice/sale-invoice.schema';
import { Party, PartySchema } from '../../parties/party.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Machine, MachineSchema } from '../../../machines/schemas/machine.schema';
import { Workspace, WorkspaceSchema } from '../../../workspaces/schemas/workspace.schema';
import { WorkspaceMember, WorkspaceMemberSchema } from '../../../workspaces/schemas/workspace-member.schema';
import { User, UserSchema } from '../../../users/schemas/user.schema';
import { Subscription, SubscriptionSchema } from '../../../subscriptions/schemas/subscription.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReminderRule.name, schema: ReminderRuleSchema },
      { name: ReminderLog.name, schema: ReminderLogSchema },
      { name: ReminderSettings.name, schema: ReminderSettingsSchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: Party.name, schema: PartySchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Machine.name, schema: MachineSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      { name: User.name, schema: UserSchema },
      // Wave 7 — read appliedEntitlements.moduleAccess[REMINDERS] to gate
      // tier-locked channels before adapter dispatch.
      { name: Subscription.name, schema: SubscriptionSchema },
    ]),
    ReminderRuleModule,
    CallTodoModule,
    AdaptersModule,
  ],
  controllers: [ReminderDispatcherController],
  providers: [ReminderDispatcherService, ReminderDispatcherCron],
  exports: [ReminderDispatcherService],
})
export class ReminderDispatcherModule {}
