/**
 * Smart Defaults / Field Prediction module.
 *
 * Self-contained: registers the FieldPredictionMemory collection, the read
 * controller, and the service (exported so the sale-invoice post flow can
 * inject it for best-effort writes — the orchestrator wires that call).
 *
 * Registered in FinanceModule alongside the sibling finance sub-modules.
 *
 * Links to: field-prediction-memory.schema, smart-defaults.service,
 * smart-defaults.controller.
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  FieldPredictionMemory,
  FieldPredictionMemorySchema,
} from './schemas/field-prediction-memory.schema';
import { SmartDefaultsService } from './smart-defaults.service';
import { SmartDefaultsController } from './smart-defaults.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: FieldPredictionMemory.name,
        schema: FieldPredictionMemorySchema,
      },
    ]),
  ],
  providers: [SmartDefaultsService],
  controllers: [SmartDefaultsController],
  exports: [SmartDefaultsService],
})
export class SmartDefaultsModule {}
