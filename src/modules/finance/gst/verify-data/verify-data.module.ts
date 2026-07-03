import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SaleInvoice, SaleInvoiceSchema } from '../../sales/sale-invoice/sale-invoice.schema';
import { CreditNote, CreditNoteSchema } from '../../credit-notes/credit-note.schema';
import { DebitNote, DebitNoteSchema } from '../../debit-notes/debit-note.schema';
import {
  GodownBalance,
  GodownBalanceSchema,
} from '../../inventory/godown-balances/godown-balance.schema';
import {
  LedgerEntry,
  LedgerEntrySchema,
} from '../../sales/ledger-posting/ledger-entry.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Party, PartySchema } from '../../parties/party.schema';
import {
  VerifyDataResult,
  VerifyDataResultSchema,
} from './verify-data.schema';
import { GstRateHistoryModule } from '../gst-rate-history/gst-rate-history.module';
import { VerifyDataService } from './verify-data.service';
import { VerifyDataCronService } from './verify-data-cron.service';
import { VerifyDataController } from './verify-data.controller';

/**
 * VerifyDataModule — Wave 4 (F-12-06) Verify-My-Data scanner module.
 *
 * Provides:
 *   - VerifyDataService: orchestrates 11 checks + persists VerifyDataResult
 *   - VerifyDataCronService: nightly 02:00 IST cron (firm × period loop)
 *   - VerifyDataController: POST /run + GET /results endpoints
 *
 * Models registered:
 *   SaleInvoice, CreditNote, DebitNote, GodownBalance, LedgerEntry, Firm, Party,
 *   VerifyDataResult (TTL 90 days, Wave 1 schema)
 *
 * Imports:
 *   GstRateHistoryModule — exports GstRateHistoryService required by C-11 rate-discrepancy check
 *
 * NOTE: ScheduleModule.forRoot() is NOT imported here — it is already registered
 * globally in SalaryModule. NestJS cron decorators work as long as
 * ScheduleModule.forRoot() is present anywhere in the application.
 *
 * T-12-W4-01: per-firm try/catch in cron prevents one firm blocking others
 * T-12-W4-02: all queries scoped to wsId + firmId (workspace isolation)
 * T-12-W4-03: @RequireSubscription gst_compliance on controller + cron filters by entitlement
 * T-12-W4-07: C-11 calls GstRateHistoryService.getRateAsOf; tolerance > 0.5% filters rounding noise
 * T-12-W4-08: c-01/c-02/c-03/c-05/c-08 are thin re-exporters of gstr1/checks/common.ts
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: CreditNote.name, schema: CreditNoteSchema },
      { name: DebitNote.name, schema: DebitNoteSchema },
      { name: GodownBalance.name, schema: GodownBalanceSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Party.name, schema: PartySchema },
      { name: VerifyDataResult.name, schema: VerifyDataResultSchema },
    ]),
    // REQUIRED — exports GstRateHistoryService used by C-11 rate-discrepancy check
    GstRateHistoryModule,
  ],
  controllers: [VerifyDataController],
  providers: [VerifyDataService, VerifyDataCronService],
  exports: [VerifyDataService],
})
export class VerifyDataModule {}
