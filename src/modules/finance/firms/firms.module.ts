import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Firm, FirmSchema } from './firm.schema';
import { FirmsService } from './firms.service';
import { FirmsController } from './firms.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { VoucherSeriesModule } from '../voucher-series/voucher-series.module';
import { CashRegistersModule } from '../cash-registers/cash-registers.module';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';
import { GodownsModule } from '../inventory/godowns/godowns.module';
import { FiscalYearModule } from '../fiscal-year/fiscal-year.module';
import { AuditModule } from '../../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Firm.name, schema: FirmSchema }]),
    AuditModule,
    LedgerModule,
    VoucherSeriesModule,
    CashRegistersModule,
    WorkspacesModule,
    SubscriptionsModule,
    forwardRef(() => GodownsModule),
    forwardRef(() => FiscalYearModule),
  ],
  controllers: [FirmsController],
  providers: [FirmsService],
  exports: [FirmsService, MongooseModule],
})
export class FirmsModule {}
