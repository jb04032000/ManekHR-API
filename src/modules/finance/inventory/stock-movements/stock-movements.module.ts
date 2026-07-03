import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StockMovement, StockMovementSchema } from './stock-movement.schema';
import { Item, ItemSchema } from '../../items/item.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Lot, LotSchema } from '../lots/lot.schema';
import { StockMovementsService } from './stock-movements.service';
import { StockMovementsController } from './stock-movements.controller';
import { GodownBalanceModule } from '../godown-balances/godown-balance.module';
import { ValuationModule } from '../valuation/valuation.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: StockMovement.name, schema: StockMovementSchema },
      { name: Item.name, schema: ItemSchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Lot.name, schema: LotSchema },
    ]),
    GodownBalanceModule,
    ValuationModule,
  ],
  providers: [StockMovementsService],
  controllers: [StockMovementsController],
  exports: [StockMovementsService],
})
export class StockMovementsModule {}
