import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ManufacturingVoucher,
  ManufacturingVoucherSchema,
} from './manufacturing-voucher.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Item, ItemSchema } from '../../items/item.schema';
import { ManufacturingVouchersService } from './manufacturing-vouchers.service';
import { ManufacturingVouchersController } from './manufacturing-vouchers.controller';

import { BomModule } from '../bom/bom.module';
import { InventoryModule } from '../../inventory/inventory.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { LedgerPostingModule } from '../../sales/ledger-posting/ledger-posting.module';
import { FiscalYearModule } from '../../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ManufacturingVoucher.name, schema: ManufacturingVoucherSchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Item.name, schema: ItemSchema },
    ]),
    BomModule,
    InventoryModule, // exposes StockMovementsModule, BatchesModule, LotsModule, GodownBalanceModule, WastageModule
    VoucherSeriesModule,
    LedgerPostingModule,
    FiscalYearModule,
  ],
  controllers: [ManufacturingVouchersController],
  providers: [ManufacturingVouchersService],
  exports: [ManufacturingVouchersService],
})
export class ManufacturingVouchersModule {}
