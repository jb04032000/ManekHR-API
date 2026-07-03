import { Global, Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { MachinesPlanMigrationService } from './machines-plan-migration.service';
import { FinancePlanMigrationService } from './finance-plan-migration.service';
import { AttendancePlanMigrationService } from './attendance-plan-migration.service';
import { Plan, PlanSchema } from './schemas/plan.schema';
import { Subscription, SubscriptionSchema } from './schemas/subscription.schema';
import { AppSettings, AppSettingsSchema } from './schemas/app-settings.schema';
import { Tier, TierSchema } from './schemas/tier.schema';
import { AddOnsModule } from '../add-ons/add-ons.module';
import { BillingModule } from './billing/billing.module';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { Workspace, WorkspaceSchema } from '../workspaces/schemas/workspace.schema';
import {
  WorkspaceMember,
  WorkspaceMemberSchema,
} from '../workspaces/schemas/workspace-member.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

@Global()
@Module({
  imports: [
    // @Cron jobs in this module are registered by the single
    // ScheduleModule.forRoot() in SalaryModule. forRoot() is NOT idempotent in
    // @nestjs/schedule v6 — re-registering it here duplicated every cron. Removed.
    MongooseModule.forFeature([
      { name: Plan.name, schema: PlanSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: AppSettings.name, schema: AppSettingsSchema },
      { name: Tier.name, schema: TierSchema },
      // SubscriptionGuard pulls Workspace for ownerId resolution.
      { name: Workspace.name, schema: WorkspaceSchema },
      // getMySubscription asserts caller membership before resolving a
      // non-owner's workspace subscription (audit gap G2).
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      // Phase-2 ERP pricing — downgradeToBasePlan looks up the user's email to
      // send the one-time post-expiry "you're now on Free" notice. (forFeature
      // is idempotent; BillingModule also registers User on the same client.)
      { name: User.name, schema: UserSchema },
    ]),
    forwardRef(() => AddOnsModule),
    forwardRef(() => BillingModule),
  ],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    MachinesPlanMigrationService,
    FinancePlanMigrationService,
    AttendancePlanMigrationService,
    // D1g — register SubscriptionGuard here (Global module) so its
    // BillingPolicyService dep resolves universally + every controller
    // using @UseGuards(SubscriptionGuard) gets a fully-DI'd instance.
    SubscriptionGuard,
  ],
  exports: [
    SubscriptionsService,
    MongooseModule,
    SubscriptionGuard,
    // Exported so the ledgered migration runner (ADR-0001 Slice 5) can run these
    // plan-migration backfills via `npm run migrate` instead of onModuleInit.
    MachinesPlanMigrationService,
    FinancePlanMigrationService,
    AttendancePlanMigrationService,
  ],
})
export class SubscriptionsModule {}
