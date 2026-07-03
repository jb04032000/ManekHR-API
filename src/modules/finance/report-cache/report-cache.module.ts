import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FinanceDataVersion, FinanceDataVersionSchema } from './finance-data-version.schema';
import { ReportCacheService } from './report-cache.service';

// D17 report cache. Exports ReportCacheService (+ the version model) so report services can wrap
// their computation in getOrCompute, and so the LedgerEntry post-save hook can resolve the
// FinanceDataVersion model by name to bump it on each posting.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FinanceDataVersion.name, schema: FinanceDataVersionSchema },
    ]),
  ],
  providers: [ReportCacheService],
  exports: [ReportCacheService, MongooseModule],
})
export class ReportCacheModule {}
