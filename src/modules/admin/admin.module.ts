import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AddOnsModule } from '../add-ons/add-ons.module';
import { UploadsModule } from '../uploads/uploads.module';
import { AuditModule } from '../audit/audit.module';
import { PtSlabConfig, PtSlabConfigSchema } from '../salary/schemas/pt-slab.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PtSlabConfig.name, schema: PtSlabConfigSchema },
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
    // AdminModule.
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
