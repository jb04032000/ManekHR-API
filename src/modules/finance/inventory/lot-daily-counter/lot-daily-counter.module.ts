import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  LotDailyCounter,
  LotDailyCounterSchema,
} from './lot-daily-counter.schema';
import { LotDailyCounterService } from './lot-daily-counter.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LotDailyCounter.name, schema: LotDailyCounterSchema },
    ]),
  ],
  providers: [LotDailyCounterService],
  exports: [LotDailyCounterService],
})
export class LotDailyCounterModule {}
