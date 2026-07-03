import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JobWorkInvoice, JobWorkInvoiceSchema } from './jw-invoice.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Party, PartySchema } from '../../parties/party.schema';
import {
  LedgerEntry,
  LedgerEntrySchema,
} from '../../sales/ledger-posting/ledger-entry.schema';
import { JwInvoiceService } from './jw-invoice.service';
import { JwInvoiceController } from './jw-invoice.controller';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { LedgerPostingModule } from '../../sales/ledger-posting/ledger-posting.module';
import { KarigarLinkageModule } from '../karigar-linkage/karigar-linkage.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobWorkInvoice.name, schema: JobWorkInvoiceSchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Party.name, schema: PartySchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
    VoucherSeriesModule,
    LedgerPostingModule,
    KarigarLinkageModule,
  ],
  providers: [JwInvoiceService],
  controllers: [JwInvoiceController],
  exports: [JwInvoiceService, MongooseModule],
})
export class JwInvoiceModule {}
