import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  JobWorkInwardChallan,
  JobWorkInwardChallanSchema,
} from './jw-inward-challan.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { JwInwardChallanService } from './jw-inward-challan.service';
import { JwInwardChallanController } from './jw-inward-challan.controller';
import { JwLotModule } from '../jw-lot/jw-lot.module';
import { KarigarLinkageModule } from '../karigar-linkage/karigar-linkage.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FiscalYearModule } from '../../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobWorkInwardChallan.name, schema: JobWorkInwardChallanSchema },
      { name: Firm.name, schema: FirmSchema },
    ]),
    JwLotModule,
    KarigarLinkageModule,
    VoucherSeriesModule,
    FiscalYearModule,
  ],
  providers: [JwInwardChallanService],
  controllers: [JwInwardChallanController],
  exports: [JwInwardChallanService],
})
export class JwInwardChallanModule {}
