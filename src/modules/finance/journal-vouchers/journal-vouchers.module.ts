import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JournalVoucher, JournalVoucherSchema } from './journal-voucher.schema';
import { JournalVouchersService } from './journal-vouchers.service';
import { JournalVouchersController } from './journal-vouchers.controller';
import { ContraService } from './contra.service';
import { ContraController } from './contra.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { LedgerPostingModule } from '../sales/ledger-posting/ledger-posting.module';
import { VoucherSeriesModule } from '../voucher-series/voucher-series.module';
import { FirmsModule } from '../firms/firms.module';
import { CashRegistersModule } from '../cash-registers/cash-registers.module';
import { FiscalYearModule } from '../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JournalVoucher.name, schema: JournalVoucherSchema },
    ]),
    LedgerModule,               // provides AccountsService + Account model
    LedgerPostingModule,        // provides LedgerPostingService
    VoucherSeriesModule,        // provides VoucherSeriesService
    forwardRef(() => FirmsModule),                // provides FirmsService
    forwardRef(() => CashRegistersModule), // forwardRef: CashRegistersModule will also import JournalVouchersModule
    FiscalYearModule,
  ],
  controllers: [JournalVouchersController, ContraController],
  providers: [JournalVouchersService, ContraService],
  exports: [JournalVouchersService, ContraService, MongooseModule],
})
export class JournalVouchersModule {}
