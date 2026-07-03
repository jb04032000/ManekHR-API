import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SaleOrder, SaleOrderSchema } from './sale-order.schema';
import { SaleOrderService } from './sale-order.service';
import { SaleOrderController } from './sale-order.controller';
import { PartiesModule } from '../../parties/parties.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FirmsModule } from '../../firms/firms.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MailModule } from '../../../mail/mail.module';
import { PrintModule } from '../print/print.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: SaleOrder.name, schema: SaleOrderSchema }]),
    PartiesModule,
    VoucherSeriesModule,
    FirmsModule,
    InventoryModule,
    MailModule,
    PrintModule,
  ],
  controllers: [SaleOrderController],
  providers: [SaleOrderService],
  exports: [SaleOrderService],
})
export class SaleOrderModule {}
