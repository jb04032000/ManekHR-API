import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FixedAsset, FixedAssetSchema } from '../fixed-asset/fixed-asset.schema';
import { DisposalService } from './disposal.service';
import { DisposalController } from './disposal.controller';
import { ItcReversalService } from './itc-reversal.service';
import { DepreciationMathService } from '../depreciation/depreciation-math.service';
import { SalesModule } from '../../sales/sales.module';

/**
 * DisposalModule — handles asset disposal, scrapping, write-off, and non-financial transfers.
 *
 * NOTE: SalesModule is imported via forwardRef() to resolve the circular dependency
 * between FixedAssetsModule and SalesModule (LedgerPostingService lives in SalesModule).
 * This mirrors the pattern used in DepreciationModule and CapitalGoodsItcModule.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: FixedAsset.name, schema: FixedAssetSchema }]),
    forwardRef(() => SalesModule),
  ],
  controllers: [DisposalController],
  providers: [DisposalService, ItcReversalService, DepreciationMathService],
  exports: [DisposalService, ItcReversalService],
})
export class DisposalModule {}
