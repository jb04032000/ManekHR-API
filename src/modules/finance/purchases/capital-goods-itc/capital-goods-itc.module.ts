import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CapitalGoodsItcSchedule, CapitalGoodsItcScheduleSchema } from './capital-goods-itc-schedule.schema';
import { CapitalGoodsItcService } from './capital-goods-itc.service';
import { CapitalGoodsItcCron } from './capital-goods-itc.cron';
import { CapitalGoodsItcController } from './capital-goods-itc.controller';
import { SalesModule } from '../../sales/sales.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CapitalGoodsItcSchedule.name, schema: CapitalGoodsItcScheduleSchema },
    ]),
    forwardRef(() => SalesModule),
  ],
  controllers: [CapitalGoodsItcController],
  providers: [CapitalGoodsItcService, CapitalGoodsItcCron],
  exports: [CapitalGoodsItcService],
})
export class CapitalGoodsItcModule {}
