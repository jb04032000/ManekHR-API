import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ExpenseVoucher, ExpenseVoucherSchema } from './expense-voucher.schema';
import { ExpensesService } from './expenses.service';
import { ExpensesController } from './expenses.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { VoucherSeriesModule } from '../voucher-series/voucher-series.module';
import { LedgerPostingModule } from '../sales/ledger-posting/ledger-posting.module';
import { TdsModule } from '../purchases/tds/tds.module';
import { CashRegistersModule } from '../cash-registers/cash-registers.module';
import { FirmsModule } from '../firms/firms.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExpenseVoucher.name, schema: ExpenseVoucherSchema },
    ]),
    LedgerModule,        // provides AccountsService + Account model (MongooseModule exported)
    VoucherSeriesModule, // provides VoucherSeriesService
    LedgerPostingModule, // provides LedgerPostingService
    TdsModule,           // provides TdsService
    CashRegistersModule, // provides CashRegistersService
    FirmsModule,         // provides FirmsService
  ],
  controllers: [ExpensesController],
  providers: [ExpensesService],
  exports: [ExpensesService, MongooseModule],
})
export class ExpensesModule {}
