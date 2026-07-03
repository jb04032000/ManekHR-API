import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  GodownBalance,
  GodownBalanceSchema,
} from '../godown-balances/godown-balance.schema';
import { Item, ItemSchema } from '../../items/item.schema';
import {
  ItemValuationLayer,
  ItemValuationLayerSchema,
} from '../valuation/item-valuation-layer.schema';
import { Lot, LotSchema } from '../lots/lot.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { StockSummaryService } from './stock-summary.service';
import { StockSummaryController } from './stock-summary.controller';

/**
 * NOTE FOR 09-08 EXECUTOR: The top-level InventoryModule (built in plan 09-08)
 * MUST import StockSummaryModule to auto-discover StockSummaryController.
 * Without this import, GET /stock-summary and GET /stock-summary/:itemId will 404.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GodownBalance.name, schema: GodownBalanceSchema },
      { name: Item.name, schema: ItemSchema },
      { name: ItemValuationLayer.name, schema: ItemValuationLayerSchema },
      { name: Lot.name, schema: LotSchema },
      { name: Firm.name, schema: FirmSchema },
    ]),
  ],
  providers: [StockSummaryService],
  controllers: [StockSummaryController],
  exports: [StockSummaryService],
})
export class StockSummaryModule {}
