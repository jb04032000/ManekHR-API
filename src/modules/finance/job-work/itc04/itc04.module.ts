import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  JobWorkInwardChallan,
  JobWorkInwardChallanSchema,
} from '../jw-inward/jw-inward-challan.schema';
import {
  JobWorkOutwardChallan,
  JobWorkOutwardChallanSchema,
} from '../jw-outward/jw-outward-challan.schema';
import { JobWorkLot, JobWorkLotSchema } from '../jw-lot/jw-lot.schema';
import { Firm, FirmSchema } from '../../firms/firm.schema';
import { Itc04Service } from './itc04.service';
import { Itc04Controller } from './itc04.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobWorkInwardChallan.name, schema: JobWorkInwardChallanSchema },
      { name: JobWorkOutwardChallan.name, schema: JobWorkOutwardChallanSchema },
      { name: JobWorkLot.name, schema: JobWorkLotSchema },
      { name: Firm.name, schema: FirmSchema },
    ]),
  ],
  providers: [Itc04Service],
  controllers: [Itc04Controller],
  exports: [Itc04Service],
})
export class Itc04Module {}
