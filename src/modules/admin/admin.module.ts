import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminConnectEntitlementsController } from './admin-connect-entitlements.controller';
import { AdminConnectEntitlementsService } from './admin-connect-entitlements.service';
import { AdminConnectDemoController } from './admin-connect-demo.controller';
import { AdminConnectDemoService } from './admin-connect-demo.service';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AddOnsModule } from '../add-ons/add-ons.module';
import { UploadsModule } from '../uploads/uploads.module';
import { AuditModule } from '../audit/audit.module';
import { ConnectAllowanceModule } from '../connect/monetization/connect-allowance.module';
import { ConnectUsageModule } from '../connect/usage/connect-usage.module';
import { PtSlabConfig, PtSlabConfigSchema } from '../salary/schemas/pt-slab.schema';
import {
  ConnectProfile,
  ConnectProfileSchema,
} from '../connect/profile/schemas/connect-profile.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PtSlabConfig.name, schema: PtSlabConfigSchema },
      // Connect footprint signal for the unified users console (read-only here).
      { name: ConnectProfile.name, schema: ConnectProfileSchema },
    ]),
    UsersModule,
    // OQ-3: AuthModule provides AccountErasureService for the admin-only
    // DPDP erasure endpoint. AuthModule does NOT import AdminModule, so no cycle.
    AuthModule,
    // Account-deletion Phase 1: AccountDeletionService for the admin-mediated
    // restore-deletion endpoint. AccountDeletionModule does NOT import
    // AdminModule, so no cycle.
    AccountDeletionModule,
    WorkspacesModule,
    SubscriptionsModule,
    AddOnsModule,
    // Wave 5 — admin storage recompute endpoint uses UploadsService.
    UploadsModule,
    AuditModule,
    // Per-user Connect entitlements console. ConnectAllowanceModule provides the
    // allowance reader + the Subscription/Plan models (re-exported); ConnectUsage
    // module provides the usage roll-up. No cycle: Connect modules never import
    // AdminModule.
    ConnectAllowanceModule,
    ConnectUsageModule,
  ],
  controllers: [AdminController, AdminConnectEntitlementsController, AdminConnectDemoController],
  providers: [AdminService, AdminConnectEntitlementsService, AdminConnectDemoService],
  exports: [AdminService],
})
export class AdminModule {}
