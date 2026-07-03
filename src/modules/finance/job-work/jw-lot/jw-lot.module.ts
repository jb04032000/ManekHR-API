import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JobWorkLot, JobWorkLotSchema } from './jw-lot.schema';
import { JwLotService } from './jw-lot.service';
import { JwLotController } from './jw-lot.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobWorkLot.name, schema: JobWorkLotSchema },
    ]),
  ],
  providers: [JwLotService],
  controllers: [JwLotController],
  exports: [JwLotService, MongooseModule],
})
export class JwLotModule {}
