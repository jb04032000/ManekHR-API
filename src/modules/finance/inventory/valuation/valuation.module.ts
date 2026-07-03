import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ItemValuationLayer,
  ItemValuationLayerSchema,
} from './item-valuation-layer.schema';
import { Item, ItemSchema } from '../../items/item.schema';
import { ValuationService } from './valuation.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: ItemValuationLayer.name,
        schema: ItemValuationLayerSchema,
      },
      { name: Item.name, schema: ItemSchema },
    ]),
  ],
  providers: [ValuationService],
  exports: [ValuationService],
})
export class ValuationModule {}
