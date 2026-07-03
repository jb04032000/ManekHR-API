import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FixedAsset, FixedAssetSchema } from './fixed-asset.schema';
import { AssetCategory, AssetCategorySchema } from '../asset-category/asset-category.schema';
import { FixedAssetService } from './fixed-asset.service';
import { FixedAssetController } from './fixed-asset.controller';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FixedAsset.name, schema: FixedAssetSchema },
      { name: AssetCategory.name, schema: AssetCategorySchema },
    ]),
    VoucherSeriesModule,
  ],
  controllers: [FixedAssetController],
  providers: [FixedAssetService],
  exports: [FixedAssetService, MongooseModule],
})
export class FixedAssetModule {}
