import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LateFeeEntry, LateFeeEntrySchema } from './late-fee.schema';
import { LateFeeService } from './late-fee.service';
import { LateFeeAccrualCron } from './late-fee.cron';
import { SaleInvoice, SaleInvoiceSchema } from '../../sales/sale-invoice/sale-invoice.schema';
import { LedgerModule } from '../../ledger/ledger.module';
import { LedgerPostingModule } from '../../sales/ledger-posting/ledger-posting.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LateFeeEntry.name, schema: LateFeeEntrySchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
    ]),
    LedgerModule, // provides AccountsService
    LedgerPostingModule, // provides LedgerPostingService (central posting path)
  ],
  providers: [LateFeeService, LateFeeAccrualCron],
  exports: [LateFeeService],
})
export class LateFeeModule {}
