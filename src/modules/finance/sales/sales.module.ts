import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IdempotencyService } from './common/idempotency.service';
import { TaxComputationModule } from './tax-computation/tax-computation.module';
import { LedgerPostingModule } from './ledger-posting/ledger-posting.module';
import { PartySalesAggregateModule } from './party-sales-aggregate/party-sales-aggregate.module';
import { InventoryModule } from './inventory/inventory.module';
import { PrintModule } from './print/print.module';
import { SaleInvoiceModule } from './sale-invoice/sale-invoice.module';
import { QuotationModule } from './quotation/quotation.module';
import { SaleOrderModule } from './sale-order/sale-order.module';
import { ProformaModule } from './proforma/proforma.module';
import { DeliveryChallanModule } from './delivery-challan/delivery-challan.module';
import { ConvertModule } from './convert/convert.module';
import { RecurringModule } from './recurring/recurring.module';
import { EInvoiceModule } from './einvoice/einvoice.module';
import { EwaybillModule } from './ewaybill/ewaybill.module';

@Module({
  imports: [
    ConfigModule,
    TaxComputationModule,
    LedgerPostingModule,
    PartySalesAggregateModule,
    InventoryModule,
    PrintModule,
    SaleInvoiceModule,
    QuotationModule,
    SaleOrderModule,
    ProformaModule,
    DeliveryChallanModule,
    ConvertModule,
    RecurringModule,
    EInvoiceModule,
    EwaybillModule,
  ],
  providers: [IdempotencyService],
  exports: [
    IdempotencyService,
    TaxComputationModule,
    LedgerPostingModule,
    PartySalesAggregateModule,
    InventoryModule,
    PrintModule,
    SaleInvoiceModule,
    QuotationModule,
    SaleOrderModule,
    ProformaModule,
    DeliveryChallanModule,
    ConvertModule,
    RecurringModule,
    EInvoiceModule,
    EwaybillModule,
  ],
})
export class SalesModule {}
