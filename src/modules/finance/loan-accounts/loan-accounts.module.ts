import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LoanAccount, LoanAccountSchema } from './loan-account.schema';
import { LoanScheduleEntry, LoanScheduleEntrySchema } from './loan-schedule-entry.schema';
import { LoanEmiRun, LoanEmiRunSchema } from './loan-emi-run.schema';
import { LoanAccountsService } from './loan-accounts.service';
import { LoanScheduleService } from './loan-schedule.service';
import { LoanAccountsController } from './loan-accounts.controller';
import { LoanEmiCron } from './loan-emi.cron';
import { LedgerPostingModule } from '../sales/ledger-posting/ledger-posting.module';
import { VoucherSeriesModule } from '../voucher-series/voucher-series.module';
import { FirmsModule } from '../firms/firms.module';

/**
 * LoanAccountsModule
 *
 * Registers 3 schemas (LoanAccount, LoanScheduleEntry, LoanEmiRun),
 * wires LoanAccountsService + LoanEmiCron + LoanAccountsController.
 *
 * NOTE: ScheduleModule.forRoot() is NOT registered here.
 * It is already registered globally in SalaryModule.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LoanAccount.name, schema: LoanAccountSchema },
      { name: LoanScheduleEntry.name, schema: LoanScheduleEntrySchema },
      { name: LoanEmiRun.name, schema: LoanEmiRunSchema },
    ]),
    LedgerPostingModule,   // provides LedgerPostingService (postLoanEmi, postLoanDisbursement)
    VoucherSeriesModule,   // provides VoucherSeriesService (generateNextNumber for loanCode)
    FirmsModule,           // provides FirmsService (fyStartMonth + firm context)
  ],
  controllers: [LoanAccountsController],
  providers: [LoanAccountsService, LoanScheduleService, LoanEmiCron],
  exports: [LoanAccountsService, LoanScheduleService, MongooseModule],
})
export class LoanAccountsModule {}
