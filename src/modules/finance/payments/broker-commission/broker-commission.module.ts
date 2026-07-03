import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BrokerCommissionEntry, BrokerCommissionEntrySchema } from './broker-commission.schema';
import { BrokerCommissionService } from './broker-commission.service';
import { SaleInvoice, SaleInvoiceSchema } from '../../sales/sale-invoice/sale-invoice.schema';
import { LedgerEntry, LedgerEntrySchema } from '../../sales/ledger-posting/ledger-entry.schema';
import { LedgerModule } from '../../ledger/ledger.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BrokerCommissionEntry.name, schema: BrokerCommissionEntrySchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
    LedgerModule,
  ],
  providers: [BrokerCommissionService],
  exports: [BrokerCommissionService],
})
export class BrokerCommissionModule {}
