import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ImportService } from './import.service';
import { ImportController } from './import.controller';
import { OpeningInvoice, OpeningInvoiceSchema } from './opening-invoice.schema';
import { PartiesModule } from '../parties/parties.module';
import { ItemsModule } from '../items/items.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OpeningBalanceModule } from '../sales/ledger-posting/opening-balance.module';
import { LedgerPostingModule } from '../sales/ledger-posting/ledger-posting.module';
import { FiscalYearModule } from '../fiscal-year/fiscal-year.module';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';

// D19 onboarding import. Entities: parties, opening balances, item masters, pending invoices.
// PartiesModule -> party create + dedup; ItemsModule -> item create; LedgerModule -> AccountsService;
// OpeningBalanceModule -> lock-aware account opening balances; LedgerPostingModule -> postManualJournal
// for the bill-wise opening-AR posting (Dr Debtors / Cr 3004); OpeningInvoice = the separate
// pending-bill collection (kept out of SaleInvoice so it can't touch sales/GST reports).
@Module({
  imports: [
    MongooseModule.forFeature([{ name: OpeningInvoice.name, schema: OpeningInvoiceSchema }]),
    PartiesModule,
    ItemsModule,
    LedgerModule,
    OpeningBalanceModule,
    LedgerPostingModule,
    FiscalYearModule, // R9: FyLockService - pending-invoice import must respect the period lock
    WorkspacesModule,
    SubscriptionsModule,
  ],
  controllers: [ImportController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
