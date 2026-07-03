import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BankStatement, BankStatementSchema } from './bank-statement.schema';
import { BankStatementRow, BankStatementRowSchema } from './bank-statement-row.schema';
import { ReconciliationSession, ReconciliationSessionSchema } from './reconciliation-session.schema';
import { LedgerEntry, LedgerEntrySchema } from '../sales/ledger-posting/ledger-entry.schema';
import { BankAccount, BankAccountSchema } from '../bank-accounts/bank-account.schema';
import { Firm, FirmSchema } from '../firms/firm.schema';
import { Account, AccountSchema } from '../ledger/account.schema';
import { BankStatementParserService } from './bank-statement-parser.service';
import { BankReconciliationService } from './bank-reconciliation.service';
import { BrsReportService } from './brs-report.service';
import { CreateFromRowService } from './create-from-row.service';
import { BankReconciliationController } from './bank-reconciliation.controller';
import { FiscalYearModule } from '../fiscal-year/fiscal-year.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BankStatement.name, schema: BankStatementSchema },
      { name: BankStatementRow.name, schema: BankStatementRowSchema },
      { name: ReconciliationSession.name, schema: ReconciliationSessionSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: BankAccount.name, schema: BankAccountSchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Account.name, schema: AccountSchema },
    ]),
    FiscalYearModule,
  ],
  providers: [
    BankStatementParserService,
    BankReconciliationService,
    BrsReportService,
    CreateFromRowService,
  ],
  controllers: [BankReconciliationController],
  exports: [
    MongooseModule,
    BankStatementParserService,
    BankReconciliationService,
    BrsReportService,
    CreateFromRowService,
  ],
})
export class BankReconciliationModule {}
