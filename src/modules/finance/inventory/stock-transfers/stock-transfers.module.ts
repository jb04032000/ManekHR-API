import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StockTransfer, StockTransferSchema } from './stock-transfer.schema';
import { Lot, LotSchema } from '../lots/lot.schema';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { GodownBalanceModule } from '../godown-balances/godown-balance.module';
import { ValuationModule } from '../valuation/valuation.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { StockTransfersService } from './stock-transfers.service';
import { StockTransfersController } from './stock-transfers.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: StockTransfer.name, schema: StockTransferSchema },
      { name: Lot.name, schema: LotSchema },
    ]),
    StockMovementsModule,
    GodownBalanceModule,
    ValuationModule,
    VoucherSeriesModule,
  ],
  providers: [StockTransfersService],
  controllers: [StockTransfersController],
  exports: [StockTransfersService],
})
export class StockTransfersModule {}
