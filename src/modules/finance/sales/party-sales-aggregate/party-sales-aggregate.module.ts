import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PartySalesAggregate, PartySalesAggregateSchema } from './party-sales-aggregate.schema';
import { PartySalesAggregateService } from './party-sales-aggregate.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PartySalesAggregate.name, schema: PartySalesAggregateSchema },
    ]),
  ],
  providers: [PartySalesAggregateService],
  exports: [PartySalesAggregateService],
})
export class PartySalesAggregateModule {}
