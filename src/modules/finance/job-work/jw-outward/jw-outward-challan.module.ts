import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  JobWorkOutwardChallan,
  JobWorkOutwardChallanSchema,
} from './jw-outward-challan.schema';
import {
  JobWorkInwardChallan,
  JobWorkInwardChallanSchema,
} from '../jw-inward/jw-inward-challan.schema';
import { JobWorkLot, JobWorkLotSchema } from '../jw-lot/jw-lot.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Party, PartySchema } from '../../parties/party.schema';
import { JwOutwardChallanService } from './jw-outward-challan.service';
import { JwOutwardChallanController } from './jw-outward-challan.controller';
import { JwLotModule } from '../jw-lot/jw-lot.module';
import { KarigarLinkageModule } from '../karigar-linkage/karigar-linkage.module';
import { JwInvoiceModule } from '../jw-invoice/jw-invoice.module';
import { VoucherSeriesModule } from '../../voucher-series/voucher-series.module';
import { FiscalYearModule } from '../../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobWorkOutwardChallan.name, schema: JobWorkOutwardChallanSchema },
      { name: JobWorkInwardChallan.name, schema: JobWorkInwardChallanSchema },
      { name: JobWorkLot.name, schema: JobWorkLotSchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Party.name, schema: PartySchema },
    ]),
    JwLotModule,
    KarigarLinkageModule,
    JwInvoiceModule,
    VoucherSeriesModule,
    FiscalYearModule,
  ],
  providers: [JwOutwardChallanService],
  controllers: [JwOutwardChallanController],
  exports: [JwOutwardChallanService, MongooseModule],
})
export class JwOutwardChallanModule {}
