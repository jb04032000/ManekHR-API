import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BankAccount, BankAccountSchema } from './bank-account.schema';
import { LedgerEntry, LedgerEntrySchema } from '../sales/ledger-posting/ledger-entry.schema';
import { BankAccountsService } from './bank-accounts.service';
import { BankAccountsController } from './bank-accounts.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BankAccount.name, schema: BankAccountSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
  ],
  controllers: [BankAccountsController],
  providers: [BankAccountsService],
  exports: [BankAccountsService, MongooseModule],
})
export class BankAccountsModule {}
