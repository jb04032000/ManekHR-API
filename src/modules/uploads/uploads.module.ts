import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { UploadsController } from './uploads.controller';
import { UploadsPrivateDevController } from './uploads-private-dev.controller';
import { UploadsService } from './uploads.service';
import { LocalStorageService } from './services/local-storage.service';
import { R2StorageService } from './services/r2-storage.service';
import { StorageOrphanReconcileCron } from './crons/storage-orphan-reconcile.cron';
import storageConfig from '../../config/storage.config';
import { Workspace, WorkspaceSchema } from '../workspaces/schemas/workspace.schema';
import {
  WorkspaceMember,
  WorkspaceMemberSchema,
} from '../workspaces/schemas/workspace-member.schema';
import { UploadEvent, UploadEventSchema } from './schemas/upload-event.schema';
import { ConnectAllowanceModule } from '../connect/monetization/connect-allowance.module';

@Module({
  imports: [
    ConfigModule.forFeature(storageConfig),
    // Wave-3 Drift #36 — workspace storage quota tracking needs Workspace model.
    // Subscription model accessed via SubscriptionsModule (@Global).
    MongooseModule.forFeature([
      { name: Workspace.name, schema: WorkspaceSchema },
      // Server-side workspace attribution: verify the uploader is a member of
      // the workspace it is charging before touching that workspace's quota.
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      // Wave 5 — UploadEvent log enables admin recompute when storage counter drifts.
      { name: UploadEvent.name, schema: UploadEventSchema },
    ]),
    // Connect per-user storage allowance source. Self-contained module (no
    // AdsModule dependency), safe to import here without an import cycle.
    ConnectAllowanceModule,
    // StorageOrphanReconcileCron's @Cron is registered by the single
    // ScheduleModule.forRoot() in SalaryModule (the explorer scans every
    // provider in the app). forRoot() is NOT idempotent in @nestjs/schedule v6 —
    // a second registration here made every cron fire twice. Do not re-add it.
  ],
  controllers: [UploadsController, UploadsPrivateDevController],
  // StorageOrphanReconcileCron: nightly REPORT-ONLY storage drift reconcile
  // (reads UploadEvent + UploadsService.objectExists). No exports needed.
  providers: [UploadsService, LocalStorageService, R2StorageService, StorageOrphanReconcileCron],
  exports: [UploadsService],
})
export class UploadsModule {}
