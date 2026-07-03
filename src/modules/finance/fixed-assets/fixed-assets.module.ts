import { Module } from '@nestjs/common';
import { AssetCategoryModule } from './asset-category/asset-category.module';
import { FixedAssetModule } from './fixed-asset/fixed-asset.module';
import { DepreciationModule } from './depreciation/depreciation.module';
import { DisposalModule } from './disposal/disposal.module';
import { AssetLinkModule } from './links/asset-link.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [AssetCategoryModule, FixedAssetModule, DepreciationModule, DisposalModule, AssetLinkModule, ReportsModule],
  exports: [AssetCategoryModule, FixedAssetModule, DepreciationModule, DisposalModule, AssetLinkModule, ReportsModule],
})
export class FixedAssetsModule {}
