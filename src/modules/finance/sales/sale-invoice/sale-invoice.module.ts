import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SaleInvoice, SaleInvoiceSchema } from './sale-invoice.schema';
import { SaleInvoiceService } from './sale-invoice.service';
import { SaleInvoiceController } from './sale-invoice.controller';
import { TaxComputationModule } from '../tax-computation/tax-computation.module';
import { PartySalesAggregateModule } from '../party-sales-aggregate/party-sales-aggregate.module';
import { LedgerPostingModule } from '../ledger-posting/ledger-posting.module';
import { InventoryModule } from '../inventory/inventory.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FirmsModule } from '../../firms/firms.module';
import { PartiesModule } from '../../parties/parties.module';
import { IdempotencyService } from '../common/idempotency.service';
import { SaleInvoicePrintService } from './sale-invoice-print.service';
import { ConfigModule } from '@nestjs/config';
import { MailModule } from '../../../mail/mail.module';
import { PrintModule } from '../print/print.module';
import { EInvoiceModule } from '../einvoice/einvoice.module';
import { EwaybillModule } from '../ewaybill/ewaybill.module';
import { FiscalYearModule } from '../../fiscal-year/fiscal-year.module';
import { AuditModule } from '../../../audit/audit.module';
import { GstRateHistoryModule } from '../../gst/gst-rate-history/gst-rate-history.module';
import { SmartDefaultsModule } from '../../smart-defaults/smart-defaults.module';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: SaleInvoice.name, schema: SaleInvoiceSchema }]),
    TaxComputationModule,
    PartySalesAggregateModule,
    LedgerPostingModule,
    InventoryModule,
    VoucherSeriesModule,
    FirmsModule,
    PartiesModule,
    MailModule,
    PrintModule,
    EInvoiceModule,
    EwaybillModule,
    FiscalYearModule,
    // Phase 0 platform-bar: central AuditService for the billing writes.
    // PostHogService is @Global() so it needs no import here.
    AuditModule,
    // 2b: HSN rate-master lookup to default/warn the tax rate at line entry.
    GstRateHistoryModule,
    // Phase 1b: per-party "Field Prediction" memory written best-effort on post.
    SmartDefaultsModule,
  ],
  controllers: [SaleInvoiceController],
  providers: [SaleInvoiceService, IdempotencyService, SaleInvoicePrintService],
  exports: [SaleInvoiceService, SaleInvoicePrintService],
})
export class SaleInvoiceModule {}
