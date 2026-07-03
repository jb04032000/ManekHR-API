import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WastageEntry, WastageEntrySchema } from './wastage-entry.schema';
import { Item, ItemSchema } from '../../items/item.schema';
import { WastageService } from './wastage.service';
import { WastageController } from './wastage.controller';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { LedgerPostingModule } from '../../sales/ledger-posting/ledger-posting.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WastageEntry.name, schema: WastageEntrySchema },
      { name: Item.name, schema: ItemSchema },
    ]),
    StockMovementsModule,
    LedgerPostingModule,
    VoucherSeriesModule,
  ],
  providers: [WastageService],
  controllers: [WastageController],
  exports: [WastageService],
})
export class WastageModule {}
