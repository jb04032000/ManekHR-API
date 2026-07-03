import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Batch, BatchSchema } from './batch.schema';
import { BatchesService } from './batches.service';
import { BatchesController } from './batches.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Batch.name, schema: BatchSchema }]),
  ],
  providers: [BatchesService],
  controllers: [BatchesController],
  exports: [BatchesService],
})
export class BatchesModule {}
