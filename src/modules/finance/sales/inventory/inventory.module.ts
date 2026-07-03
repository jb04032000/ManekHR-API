import { forwardRef, Module } from '@nestjs/common';
import { ItemsModule } from '../../items/items.module';
import { InventoryService } from './inventory.service';
import { StockMovementsModule } from '../../inventory/stock-movements/stock-movements.module';
import { FirmsModule } from '../../firms/firms.module';

@Module({
  imports: [
    ItemsModule,   // ItemsModule exports MongooseModule with Item model
    StockMovementsModule,
    forwardRef(() => FirmsModule),
  ],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
