import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TdsTracker, TdsTrackerSchema } from './tds-tracker.schema';
import { TdsService } from './tds.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: TdsTracker.name, schema: TdsTrackerSchema }])],
  providers: [TdsService],
  exports: [TdsService],
})
export class TdsModule {}
