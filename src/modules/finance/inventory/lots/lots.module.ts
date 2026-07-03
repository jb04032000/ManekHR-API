import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Lot, LotSchema } from './lot.schema';
import { Item, ItemSchema } from '../../items/item.schema';
import { LotsService } from './lots.service';
import { LotsController } from './lots.controller';
import { LotDailyCounterModule } from '../lot-daily-counter/lot-daily-counter.module';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Lot.name, schema: LotSchema },
      { name: Item.name, schema: ItemSchema },
    ]),
    LotDailyCounterModule,
    StockMovementsModule,
  ],
  providers: [LotsService],
  controllers: [LotsController],
  exports: [LotsService],
})
export class LotsModule {}
