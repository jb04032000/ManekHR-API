import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SampleVoucher, SampleVoucherSchema } from './sample-voucher.schema';
import { Item, ItemSchema } from '../../items/item.schema';
import { SamplesService } from './samples.service';
import { SamplesController } from './samples.controller';
import { SamplesCron } from './samples.cron';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { SaleInvoiceModule } from '../../sales/sale-invoice/sale-invoice.module';

/**
 * SamplesModule — D-07 Sample / Consignment Voucher module.
 *
 * F-09-08: SaleInvoiceModule imported via forwardRef to break the cycle:
 *   SaleInvoice → InventoryModule → SamplesModule → SaleInvoiceModule
 * forwardRef() on both sides allows NestJS to resolve the circular dep at runtime.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SampleVoucher.name, schema: SampleVoucherSchema },
      { name: Item.name, schema: ItemSchema },
    ]),
    StockMovementsModule,
    VoucherSeriesModule,
    forwardRef(() => SaleInvoiceModule),
  ],
  providers: [SamplesService, SamplesCron],
  controllers: [SamplesController],
  exports: [SamplesService],
})
export class SamplesModule {}
