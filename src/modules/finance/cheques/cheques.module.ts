import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Cheque, ChequeSchema } from './cheque.schema';
import { ChequesService } from './cheques.service';
import { ChequesController } from './cheques.controller';
import { BankAccountsModule } from '../bank-accounts/bank-accounts.module';
import { LedgerPostingModule } from '../sales/ledger-posting/ledger-posting.module';
import { FirmsModule } from '../firms/firms.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Cheque.name, schema: ChequeSchema },
    ]),
    BankAccountsModule,    // provides BankAccountsService + BankAccount model
    LedgerPostingModule,   // provides LedgerPostingService
    FirmsModule,           // provides FirmsService (for fyStartMonth + firm context)
  ],
  controllers: [ChequesController],
  providers: [ChequesService],
  exports: [ChequesService, MongooseModule],
})
export class ChequesModule {}
