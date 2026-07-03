import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PurchaseOrder, PurchaseOrderSchema } from './purchase-order.schema';
import { PurchaseOrderService } from './purchase-order.service';
import { PurchaseOrderController } from './purchase-order.controller';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PurchaseOrder.name, schema: PurchaseOrderSchema }]),
    VoucherSeriesModule,
  ],
  controllers: [PurchaseOrderController],
  providers: [PurchaseOrderService],
  exports: [PurchaseOrderService],
})
export class PurchaseOrderModule {}
