import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Item, ItemSchema } from '../../items/item.schema';
import { Lot, LotSchema } from '../lots/lot.schema';
import { BarcodeService } from './barcode.service';
import { BarcodeController } from './barcode.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Item.name, schema: ItemSchema },
      { name: Lot.name, schema: LotSchema },
    ]),
  ],
  providers: [BarcodeService],
  controllers: [BarcodeController],
  exports: [BarcodeService],
})
export class BarcodeModule {}
