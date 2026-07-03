import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GrnReturn, GrnReturnSchema } from './grn-return.schema';
import {
  GoodsReceiptNote,
  GoodsReceiptNoteSchema,
} from '../purchases/grn/grn.schema';
import {
  PurchaseBill,
  PurchaseBillSchema,
} from '../purchases/purchase-bill/purchase-bill.schema';
import { GrnReturnsService } from './grn-returns.service';
import { GrnReturnsController } from './grn-returns.controller';
import { SalesModule } from '../sales/sales.module'; // exports InventoryModule (InventoryService)
import { VoucherSeriesModule } from '../voucher-series/voucher-series.module';
import { FiscalYearModule } from '../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GrnReturn.name, schema: GrnReturnSchema },
      { name: GoodsReceiptNote.name, schema: GoodsReceiptNoteSchema },
      { name: PurchaseBill.name, schema: PurchaseBillSchema },
    ]),
    SalesModule,         // exports InventoryService (used for stockOut/stockIn)
    VoucherSeriesModule, // exports VoucherSeriesService
    FiscalYearModule,
  ],
  controllers: [GrnReturnsController],
  providers: [GrnReturnsService],
  exports: [GrnReturnsService, MongooseModule],
})
export class GrnReturnsModule {}
