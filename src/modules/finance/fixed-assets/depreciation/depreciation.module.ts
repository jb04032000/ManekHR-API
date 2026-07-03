import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DepreciationRun, DepreciationRunSchema } from './depreciation-run.schema';
import { FixedAsset, FixedAssetSchema } from '../fixed-asset/fixed-asset.schema';
import { AssetCategory, AssetCategorySchema } from '../asset-category/asset-category.schema';
import { DepreciationRunService } from './depreciation-run.service';
import { DepreciationCron } from './depreciation.cron';
import { DepreciationController } from './depreciation.controller';
import { DepreciationMathService } from './depreciation-math.service';
import { SalesModule } from '../../sales/sales.module';
import { NotificationsModule } from '../../../notifications/notifications.module';

/**
 * DepreciationModule — orchestrates depreciation runs, cron, and controller.
 *
 * NOTE: ScheduleModule.forRoot() is NOT registered here.
 * It is already registered globally in SalaryModule.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DepreciationRun.name, schema: DepreciationRunSchema },
      { name: FixedAsset.name, schema: FixedAssetSchema },
      { name: AssetCategory.name, schema: AssetCategorySchema },
    ]),
    forwardRef(() => SalesModule),
    NotificationsModule,
  ],
  controllers: [DepreciationController],
  providers: [DepreciationRunService, DepreciationCron, DepreciationMathService],
  exports: [DepreciationRunService, DepreciationMathService],
})
export class DepreciationModule {}
