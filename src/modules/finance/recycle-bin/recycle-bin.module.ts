import { Module } from '@nestjs/common';
import { RecycleBinService } from './recycle-bin.service';
import { RecycleBinCron } from './recycle-bin.cron';
import { RecycleBinController } from './recycle-bin.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { PartiesModule } from '../parties/parties.module';
import { ItemsModule } from '../items/items.module';
import { VoucherSeriesModule } from '../voucher-series/voucher-series.module';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';
import { AuditModule } from '../../audit/audit.module';

@Module({
  imports: [
    LedgerModule,
    PartiesModule,
    ItemsModule,
    VoucherSeriesModule,
    WorkspacesModule,
    SubscriptionsModule,
    AuditModule,
  ],
  controllers: [RecycleBinController],
  providers: [RecycleBinService, RecycleBinCron],
  exports: [RecycleBinService],
})
export class RecycleBinModule {}
