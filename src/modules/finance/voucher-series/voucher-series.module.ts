import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VoucherSeries, VoucherSeriesSchema } from './voucher-series.schema';
import { VoucherSeriesService } from './voucher-series.service';
import { VoucherSeriesController } from './voucher-series.controller';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';

@Module({
  imports: [MongooseModule.forFeature([{ name: VoucherSeries.name, schema: VoucherSeriesSchema }]), WorkspacesModule, SubscriptionsModule],
  controllers: [VoucherSeriesController],
  providers: [VoucherSeriesService],
  exports: [VoucherSeriesService, MongooseModule],
})
export class VoucherSeriesModule {}
