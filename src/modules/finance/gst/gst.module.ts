import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GstRateHistoryModule } from './gst-rate-history/gst-rate-history.module';
import { Gstr3bAdjustment, Gstr3bAdjustmentSchema } from './gstr3b/gstr3b-adjustment.schema';
import { VerifyDataResult, VerifyDataResultSchema } from './verify-data/verify-data.schema';
import { Gstr1Module } from './gstr1/gstr1.module';
import { Gstr3bModule } from './gstr3b/gstr3b.module';
import { Gstr2bModule } from './gstr2b/gstr2b.module';
import { VerifyDataModule } from './verify-data/verify-data.module';

/**
 * GstModule — aggregator for all GST compliance sub-modules.
 *
 * Wave 1 (F-12-01): GstRateHistoryModule + Gstr3bAdjustment + VerifyDataResult schemas registered.
 * Wave 3 (F-12-04): Gstr1Module — 10 section builders + service + controller.
 * Wave 3 (F-12-05): Gstr3bModule — GSTR-3B auto-compute + adjustments + JSON export.
 * Wave 4 (F-12-06): VerifyDataModule — 11 data-integrity checks + cron + 2 REST endpoints.
 */
@Module({
  imports: [
    GstRateHistoryModule,
    Gstr1Module,
    Gstr3bModule,
    Gstr2bModule,
    VerifyDataModule,
    MongooseModule.forFeature([
      { name: Gstr3bAdjustment.name, schema: Gstr3bAdjustmentSchema },
      { name: VerifyDataResult.name, schema: VerifyDataResultSchema },
    ]),
  ],
  exports: [
    GstRateHistoryModule,
    Gstr1Module,
    Gstr3bModule,
    Gstr2bModule,
    VerifyDataModule,
    MongooseModule,
  ],
})
export class GstModule {}
