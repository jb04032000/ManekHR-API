import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Item, ItemSchema } from '../../items/item.schema';
import { Godown, GodownSchema } from '../godowns/godown.schema';
import {
  GodownBalance,
  GodownBalanceSchema,
} from '../godown-balances/godown-balance.schema';
import {
  StockMovement,
  StockMovementSchema,
} from '../stock-movements/stock-movement.schema';
import {
  ItemValuationLayer,
  ItemValuationLayerSchema,
} from '../valuation/item-valuation-layer.schema';
import { Account, AccountSchema } from '../../ledger/account.schema';
import { InventoryMigrationService } from './inventory-migration.service';

/**
 * InventoryMigrationModule — runs idempotent startup backfill via OnModuleInit.
 *
 * Registered in InventoryModule (top-level) which is imported by FinanceModule.
 * Account model injected here directly (no AccountsService cycle) for the COA seed.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Firm.name, schema: FirmSchema },
      { name: Item.name, schema: ItemSchema },
      { name: Godown.name, schema: GodownSchema },
      { name: GodownBalance.name, schema: GodownBalanceSchema },
      { name: StockMovement.name, schema: StockMovementSchema },
      { name: ItemValuationLayer.name, schema: ItemValuationLayerSchema },
      { name: Account.name, schema: AccountSchema },
    ]),
  ],
  providers: [InventoryMigrationService],
  exports: [InventoryMigrationService],
})
export class InventoryMigrationModule {}
