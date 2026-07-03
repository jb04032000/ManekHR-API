import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DebitNote, DebitNoteSchema } from './debit-note.schema';
import {
  PurchaseBill,
  PurchaseBillSchema,
} from '../purchases/purchase-bill/purchase-bill.schema';
import { LedgerEntry, LedgerEntrySchema } from '../sales/ledger-posting/ledger-entry.schema';
import {
  CapitalGoodsItcSchedule,
  CapitalGoodsItcScheduleSchema,
} from '../purchases/capital-goods-itc/capital-goods-itc-schedule.schema';
import { DebitNotesService } from './debit-notes.service';
import { DebitNotesController } from './debit-notes.controller';
import { SalesModule } from '../sales/sales.module'; // exports LedgerPostingModule + InventoryModule
import { VoucherSeriesModule } from '../voucher-series/voucher-series.module';
import { FirmsModule } from '../firms/firms.module';
import { GrnReturnsModule } from '../grn-returns/grn-returns.module'; // exports GrnReturnsService (WR-05)
import { FiscalYearModule } from '../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DebitNote.name, schema: DebitNoteSchema },
      { name: PurchaseBill.name, schema: PurchaseBillSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      {
        name: CapitalGoodsItcSchedule.name,
        schema: CapitalGoodsItcScheduleSchema,
      },
    ]),
    SalesModule,        // exports LedgerPostingService + InventoryService
    VoucherSeriesModule, // exports VoucherSeriesService
    FirmsModule,        // exports FirmsService
    GrnReturnsModule,   // exports GrnReturnsService — needed for DN→GRN cross-link (WR-05)
    FiscalYearModule,
  ],
  controllers: [DebitNotesController],
  providers: [DebitNotesService],
  exports: [DebitNotesService, MongooseModule],
})
export class DebitNotesModule {}
