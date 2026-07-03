import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SaleInvoice, SaleInvoiceSchema } from '../../sales/sale-invoice/sale-invoice.schema';
import { CreditNote, CreditNoteSchema } from '../../credit-notes/credit-note.schema';
import { DebitNote, DebitNoteSchema } from '../../debit-notes/debit-note.schema';
import { VoucherSeries, VoucherSeriesSchema } from '../../voucher-series/voucher-series.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Party, PartySchema } from '../../parties/party.schema';
import { Gstr1Service } from './gstr1.service';
import { Gstr1Controller } from './gstr1.controller';

/**
 * Gstr1Module — GSTR-1 JSON export, validation, and pre-flight checks.
 *
 * Provides:
 *  - Gstr1Service: composes 11-section GSTR-1 report, validates period, exports JSON
 *  - Gstr1Controller: 3 REST endpoints (GET /, validate, export)
 *
 * Models registered: SaleInvoice, CreditNote, DebitNote, VoucherSeries, Firm, Party.
 * No AdvanceReceipt yet — at.builder.ts handles absence gracefully.
 *
 * Exported: Gstr1Service (for use by GstModule aggregator and Wave 5 pages).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: CreditNote.name, schema: CreditNoteSchema },
      { name: DebitNote.name, schema: DebitNoteSchema },
      { name: VoucherSeries.name, schema: VoucherSeriesSchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Party.name, schema: PartySchema },
    ]),
  ],
  providers: [Gstr1Service],
  controllers: [Gstr1Controller],
  exports: [Gstr1Service],
})
export class Gstr1Module {}
