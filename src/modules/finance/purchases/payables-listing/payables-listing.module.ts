import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PurchaseBill, PurchaseBillSchema } from '../purchase-bill/purchase-bill.schema';
import { PayablesListingService } from './payables-listing.service';
import { PayablesListingController } from './payables-listing.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PurchaseBill.name, schema: PurchaseBillSchema }]),
  ],
  controllers: [PayablesListingController],
  providers: [PayablesListingService],
  exports: [PayablesListingService],
})
export class PayablesListingModule {}
