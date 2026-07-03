import { Module } from '@nestjs/common';
import { ConnectAllowanceModule } from '../monetization/connect-allowance.module';
import { UploadsModule } from '../../uploads/uploads.module';
import { ConnectOverLimitModule } from '../over-limit/connect-over-limit.module';
import { ConnectUsageController } from './connect-usage.controller';
import { ConnectUsageService } from './connect-usage.service';

/**
 * ManekHR Connect — Usage module. Exposes GET /me/connect/usage (per-person
 * usage vs limit for the four count caps + storage, plus over-limit / grace /
 * suppression state per kind).
 *
 * Per-kind counting + over-limit reconcile lives in ConnectOverLimitModule (one
 * source of truth so used/limit and the suppression math never diverge); this
 * module only assembles the storage row + response. Imports ConnectAllowanceModule
 * for the storage cap and UploadsModule for the canonical storage-usage aggregate.
 *
 * No import cycle: ConnectUsageModule → ConnectOverLimitModule (a leaf re:
 * usage); nothing imports ConnectUsageModule back.
 */
@Module({
  imports: [ConnectAllowanceModule, UploadsModule, ConnectOverLimitModule],
  controllers: [ConnectUsageController],
  providers: [ConnectUsageService],
  // Exported so the admin per-user entitlements screen
  // (src/modules/admin/admin-connect-entitlements.service.ts) reuses the exact
  // same usage roll-up (used/limit/over-limit per kind) it shows the person, with
  // zero counting-logic duplication.
  exports: [ConnectUsageService],
})
export class ConnectUsageModule {}
