import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FiscalYear, FiscalYearSchema } from './fiscal-year.schema';
import { Account, AccountSchema } from '../ledger/account.schema';
import {
  LedgerEntry,
  LedgerEntrySchema,
} from '../sales/ledger-posting/ledger-entry.schema';
import {
  JournalVoucher,
  JournalVoucherSchema,
} from '../journal-vouchers/journal-voucher.schema';
import { Firm, FirmSchema } from '../firms/firm.schema';
import { FiscalYearService } from './fiscal-year.service';
import { FyLockService } from './fy-lock.service';
import { FyCloseService } from './fy-close.service';
import { HealthChecksService } from './health-checks.service';
import { FiscalYearController } from './fiscal-year.controller';
import { FirmsModule } from '../firms/firms.module';
import { AuditModule } from '../../audit/audit.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';
import { RbacModule } from '../../rbac/rbac.module';

/**
 * FiscalYearModule (Phase 16 Plan 03).
 *
 * Provides:
 *   - FiscalYearService (CRUD + auto-seed + idempotent backfill)
 *   - FyLockService (assertOpen — consumed by 13 voucher-write paths)
 *   - FyCloseService (atomic close + reopen)
 *   - HealthChecksService (D-13 step 2 pre-close report)
 *   - FiscalYearController (REST surface)
 *
 * Exports FyLockService + FiscalYearService so other modules (firms, all 13
 * voucher modules) can import without circular-dep concerns.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FiscalYear.name, schema: FiscalYearSchema },
      { name: Account.name, schema: AccountSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: JournalVoucher.name, schema: JournalVoucherSchema },
      { name: Firm.name, schema: FirmSchema },
    ]),
    forwardRef(() => FirmsModule),
    AuditModule,
    SubscriptionsModule,
    RbacModule,
  ],
  controllers: [FiscalYearController],
  providers: [
    FiscalYearService,
    FyLockService,
    FyCloseService,
    HealthChecksService,
  ],
  exports: [FiscalYearService, FyLockService, MongooseModule],
})
export class FiscalYearModule {}
