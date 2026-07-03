import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentOut, PaymentOutSchema } from './payment-out.schema';
import { PurchaseBill, PurchaseBillSchema } from '../purchase-bill/purchase-bill.schema';
import { PaymentOutService } from './payment-out.service';
import { PaymentOutController } from './payment-out.controller';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FirmsModule } from '../../firms/firms.module';
import { PartiesModule } from '../../parties/parties.module';
import { SalesModule } from '../../sales/sales.module';
import { TdsModule } from '../tds/tds.module';
import { FiscalYearModule } from '../../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentOut.name, schema: PaymentOutSchema },
      { name: PurchaseBill.name, schema: PurchaseBillSchema },
    ]),
    forwardRef(() => SalesModule), // provides LedgerPostingService + IdempotencyService
    VoucherSeriesModule,
    FirmsModule,
    PartiesModule,
    TdsModule,
    FiscalYearModule,
  ],
  controllers: [PaymentOutController],
  providers: [PaymentOutService],
  exports: [PaymentOutService],
})
export class PaymentOutModule {}
