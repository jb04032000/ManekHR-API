import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HsnCode, HsnCodeSchema } from './hsn-code.schema';
import { HsnService } from './hsn.service';
import { HsnController } from './hsn.controller';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';
import { GstRateHistoryModule } from '../gst/gst-rate-history/gst-rate-history.module';

// HSN/SAC search directory (D18). Standalone module; registered in FinanceModule.
@Module({
  imports: [
    MongooseModule.forFeature([{ name: HsnCode.name, schema: HsnCodeSchema }]),
    WorkspacesModule,
    SubscriptionsModule,
    GstRateHistoryModule, // P0/D18: live effective-dated rate resolution for finder results
  ],
  controllers: [HsnController],
  providers: [HsnService],
  exports: [HsnService],
})
export class HsnModule {}
