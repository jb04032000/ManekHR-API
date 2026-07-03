import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FixedAsset, FixedAssetSchema } from '../fixed-asset/fixed-asset.schema';
import { Machine, MachineSchema } from '../../../machines/schemas/machine.schema';
import {
  CapitalGoodsItcSchedule,
  CapitalGoodsItcScheduleSchema,
} from '../../purchases/capital-goods-itc/capital-goods-itc-schedule.schema';
import {
  PurchaseBill,
  PurchaseBillSchema,
} from '../../purchases/purchase-bill/purchase-bill.schema';
import { AssetMachineLinkService } from './asset-machine-link.service';
import { AssetItcLinkService } from './asset-itc-link.service';
import { AssetLinkController } from './asset-link.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FixedAsset.name, schema: FixedAssetSchema },
      { name: Machine.name, schema: MachineSchema },
      { name: CapitalGoodsItcSchedule.name, schema: CapitalGoodsItcScheduleSchema },
      { name: PurchaseBill.name, schema: PurchaseBillSchema },
    ]),
  ],
  controllers: [AssetLinkController],
  providers: [AssetMachineLinkService, AssetItcLinkService],
  exports: [AssetMachineLinkService, AssetItcLinkService],
})
export class AssetLinkModule {}
