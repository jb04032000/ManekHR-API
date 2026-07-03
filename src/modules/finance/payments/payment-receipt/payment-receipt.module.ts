import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentReceipt, PaymentReceiptSchema } from './payment-receipt.schema';
import { PaymentReceiptService } from './payment-receipt.service';
import { PaymentReceiptController } from './payment-receipt.controller';
import { SaleInvoice, SaleInvoiceSchema } from '../../sales/sale-invoice/sale-invoice.schema';
import { LedgerPostingModule } from '../../sales/ledger-posting/ledger-posting.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FirmsModule } from '../../firms/firms.module';
import { PartiesModule } from '../../parties/parties.module';
import { SalesModule } from '../../sales/sales.module';
import { BrokerCommissionModule } from '../broker-commission/broker-commission.module';
import { FiscalYearModule } from '../../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentReceipt.name, schema: PaymentReceiptSchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
    ]),
    LedgerPostingModule,
    VoucherSeriesModule,
    FirmsModule,
    PartiesModule,
    // SalesModule provides IdempotencyService
    forwardRef(() => SalesModule),
    BrokerCommissionModule,
    FiscalYearModule,
  ],
  controllers: [PaymentReceiptController],
  providers: [PaymentReceiptService],
  exports: [PaymentReceiptService],
})
export class PaymentReceiptModule {}
