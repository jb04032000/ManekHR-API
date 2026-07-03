import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerEntry, LedgerEntrySchema } from '../../sales/ledger-posting/ledger-entry.schema';
import { SaleInvoice, SaleInvoiceSchema } from '../../sales/sale-invoice/sale-invoice.schema';
import { PartyLedgerService } from './party-ledger.service';
import { PartyLedgerController } from './party-ledger.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
    ]),
  ],
  controllers: [PartyLedgerController],
  providers: [PartyLedgerService],
  exports: [PartyLedgerService],
})
export class PartyLedgerModule {}
