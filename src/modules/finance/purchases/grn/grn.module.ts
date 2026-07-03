import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GoodsReceiptNote, GoodsReceiptNoteSchema } from './grn.schema';
import { GrnService } from './grn.service';
import { GrnController } from './grn.controller';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: GoodsReceiptNote.name, schema: GoodsReceiptNoteSchema }]),
    VoucherSeriesModule,
  ],
  controllers: [GrnController],
  providers: [GrnService],
  exports: [GrnService],
})
export class GrnModule {}
