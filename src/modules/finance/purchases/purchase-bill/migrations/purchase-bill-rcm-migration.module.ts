import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PurchaseBill, PurchaseBillSchema } from '../purchase-bill.schema';
import { LedgerEntry, LedgerEntrySchema } from '../../../sales/ledger-posting/ledger-entry.schema';
import { Account, AccountSchema } from '../../../ledger/account.schema';
import { MigrateRcmOutputTaxService } from './migrate-rcm-output-tax.service';

/**
 * Hosts the one-time RCM output-tax backfill migration (see
 * MigrateRcmOutputTaxService). The service self-gates on the
 * `RCM_OUTPUT_TAX_MIGRATION` env var ('dry-run' | 'apply'; unset = no-op), so
 * importing this module is inert until the owner opts in.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PurchaseBill.name, schema: PurchaseBillSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: Account.name, schema: AccountSchema },
    ]),
  ],
  providers: [MigrateRcmOutputTaxService],
  exports: [MigrateRcmOutputTaxService],
})
export class PurchaseBillRcmMigrationModule {}
