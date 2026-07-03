import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeliveryChallan, DeliveryChallanSchema } from './delivery-challan.schema';
import { DeliveryChallanService } from './delivery-challan.service';
import { DeliveryChallanController } from './delivery-challan.controller';
import { PartiesModule } from '../../parties/parties.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FirmsModule } from '../../firms/firms.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MailModule } from '../../../mail/mail.module';
import { PrintModule } from '../print/print.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: DeliveryChallan.name, schema: DeliveryChallanSchema }]),
    PartiesModule,
    VoucherSeriesModule,
    FirmsModule,
    InventoryModule,
    MailModule,
    PrintModule,
  ],
  controllers: [DeliveryChallanController],
  providers: [DeliveryChallanService],
  exports: [DeliveryChallanService],
})
export class DeliveryChallanModule {}
