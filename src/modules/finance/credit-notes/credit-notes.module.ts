import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CreditNote, CreditNoteSchema } from './credit-note.schema';
import { SaleInvoice, SaleInvoiceSchema } from '../sales/sale-invoice/sale-invoice.schema';
import { LedgerEntry, LedgerEntrySchema } from '../sales/ledger-posting/ledger-entry.schema';
import { CreditNotesService } from './credit-notes.service';
import { CreditNotesController } from './credit-notes.controller';
import { SalesModule } from '../sales/sales.module';
import { VoucherSeriesModule } from '../voucher-series/voucher-series.module';
import { FirmsModule } from '../firms/firms.module';
import { FiscalYearModule } from '../fiscal-year/fiscal-year.module';
import { AuditModule } from '../../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CreditNote.name, schema: CreditNoteSchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
    SalesModule, // exports LedgerPostingModule (LedgerPostingService) + InventoryModule (InventoryService)
    VoucherSeriesModule, // exports VoucherSeriesService
    FirmsModule, // exports FirmsService
    FiscalYearModule,
    // Phase 0 platform-bar: central AuditService for the credit-note write.
    // PostHogService is @Global() so it needs no import here.
    AuditModule,
  ],
  controllers: [CreditNotesController],
  providers: [CreditNotesService],
  exports: [CreditNotesService, MongooseModule],
})
export class CreditNotesModule {}
