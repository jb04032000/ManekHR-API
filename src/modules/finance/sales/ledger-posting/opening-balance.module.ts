import { Module } from '@nestjs/common';
import { LedgerPostingModule } from './ledger-posting.module';
import { LedgerModule } from '../../ledger/ledger.module';
import { WorkspacesModule } from '../../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../../subscriptions/subscriptions.module';
import { AuditModule } from '../../../audit/audit.module';
import { FiscalYearModule } from '../../fiscal-year/fiscal-year.module';
import { OpeningBalanceController } from './opening-balance.controller';
import { OpeningBalanceService } from './opening-balance.service';

// Hosts the per-account opening-balance endpoint. Imports LedgerPostingModule
// (posting service) + LedgerModule (Account model, exported MongooseModule) and
// the guard dependencies (Workspaces + Subscriptions), mirroring LedgerModule.
// Standalone module (nobody imports it) so adding a controller cannot create a
// circular dependency. Registered in FinanceModule.
@Module({
  imports: [
    LedgerPostingModule,
    LedgerModule,
    WorkspacesModule,
    SubscriptionsModule,
    AuditModule,
    FiscalYearModule, // P0: FyLockService - opening balances must respect the period lock
  ],
  controllers: [OpeningBalanceController],
  providers: [OpeningBalanceService],
  // Exported so the D19 import (ImportModule) posts opening balances through the same lock-aware,
  // invariant-enforcing service rather than reimplementing the posting.
  exports: [OpeningBalanceService],
})
export class OpeningBalanceModule {}
