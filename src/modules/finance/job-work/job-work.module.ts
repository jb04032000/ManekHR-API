import { Module } from '@nestjs/common';
import { JwLotModule } from './jw-lot/jw-lot.module';
import { JwInwardChallanModule } from './jw-inward/jw-inward-challan.module';
import { JwOutwardChallanModule } from './jw-outward/jw-outward-challan.module';
import { JwInvoiceModule } from './jw-invoice/jw-invoice.module';
import { KarigarLinkageModule } from './karigar-linkage/karigar-linkage.module';
import { Itc04Module } from './itc04/itc04.module';
import { JwPendingAlarmModule } from './pending-alarm/jw-pending-alarm.module';

/**
 * JobWorkModule — aggregates all 7 job-work sub-modules.
 * Imported by FinanceModule (F-11 Wave 1).
 */
@Module({
  imports: [
    JwLotModule,
    JwInwardChallanModule,
    JwOutwardChallanModule,
    JwInvoiceModule,
    KarigarLinkageModule,
    Itc04Module,
    JwPendingAlarmModule,
  ],
  exports: [
    JwLotModule,
    JwInwardChallanModule,
    JwOutwardChallanModule,
    JwInvoiceModule,
    KarigarLinkageModule,
    Itc04Module,
    JwPendingAlarmModule,
  ],
})
export class JobWorkModule {}
