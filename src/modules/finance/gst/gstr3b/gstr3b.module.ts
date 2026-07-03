import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerEntry, LedgerEntrySchema } from '../../sales/ledger-posting/ledger-entry.schema';
import { SaleInvoice, SaleInvoiceSchema } from '../../sales/sale-invoice/sale-invoice.schema';
import { PurchaseBill, PurchaseBillSchema } from '../../purchases/purchase-bill/purchase-bill.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Gstr3bAdjustment, Gstr3bAdjustmentSchema } from './gstr3b-adjustment.schema';
import { Gstr3bService } from './gstr3b.service';
import { Gstr3bController } from './gstr3b.controller';

/**
 * Gstr3bModule — GSTR-3B auto-computation, manual adjustment persistence, and JSON export.
 *
 * Wave 3 (F-12-05):
 *   - Gstr3bService: 14-section auto-compute from LedgerEntry aggregation,
 *     adjustment merge, nov2025Locked flag, GSTN-spec JSON export
 *   - Gstr3bController: 3 REST endpoints (GET /, PATCH /adjustments, GET /export)
 *
 * Models registered:
 *   LedgerEntry, SaleInvoice, PurchaseBill, Firm, Gstr3bAdjustment
 *
 * Exported: Gstr3bService (available to GstModule aggregator and Wave 5 web pages).
 *
 * T-12-W3-13: isReversed: false filter enforced in every aggregation
 * T-12-W3-14: upsert pattern prevents duplicate Gstr3bAdjustment per period
 * T-12-W3-15: validateAdjustments() cell-key allowlist in service
 * T-12-W3-16: all queries scoped to (wsId, firmId)
 * T-12-W3-17: @RequireSubscription gst_compliance on controller
 * T-12-W3-18: savedBy captured from JWT user
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: PurchaseBill.name, schema: PurchaseBillSchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Gstr3bAdjustment.name, schema: Gstr3bAdjustmentSchema },
    ]),
  ],
  controllers: [Gstr3bController],
  providers: [Gstr3bService],
  exports: [Gstr3bService],
})
export class Gstr3bModule {}
