import { Module } from '@nestjs/common';
import { GodownsModule } from './godowns/godowns.module';
import { StockMovementsModule } from './stock-movements/stock-movements.module';
import { GodownBalanceModule } from './godown-balances/godown-balance.module';
import { ValuationModule } from './valuation/valuation.module';
import { LotsModule } from './lots/lots.module';
import { BatchesModule } from './batches/batches.module';
import { SerialsModule } from './serials/serials.module';
import { StockTransfersModule } from './stock-transfers/stock-transfers.module';
import { WastageModule } from './wastage/wastage.module';
import { SamplesModule } from './samples/samples.module';
import { CessRulesModule } from './cess/cess-rules.module';
import { BarcodeModule } from './barcode/barcode.module';
import { LotDailyCounterModule } from './lot-daily-counter/lot-daily-counter.module';
import { InventoryMigrationModule } from './migrations/inventory-migration.module';
import { StockSummaryModule } from './stock-summary/stock-summary.module';

/**
 * Top-level InventoryModule — registers all 15 F-09 inventory sub-modules.
 * Imported by FinanceModule so all other finance services can inject inventory services.
 * InventoryMigrationModule runs onModuleInit to backfill existing data.
 */
@Module({
  imports: [
    LotDailyCounterModule,
    GodownBalanceModule,
    ValuationModule,
    StockMovementsModule,
    GodownsModule,
    LotsModule,
    BatchesModule,
    SerialsModule,
    StockTransfersModule,
    WastageModule,
    SamplesModule,
    CessRulesModule,
    BarcodeModule,
    StockSummaryModule,
    InventoryMigrationModule,
  ],
  exports: [
    GodownsModule,
    StockMovementsModule,
    GodownBalanceModule,
    ValuationModule,
    LotsModule,
    BatchesModule,
    SerialsModule,
    StockTransfersModule,
    WastageModule,
    SamplesModule,
    CessRulesModule,
    BarcodeModule,
    StockSummaryModule,
  ],
})
export class InventoryModule {}
