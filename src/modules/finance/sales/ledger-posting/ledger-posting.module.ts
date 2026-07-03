import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerEntry, LedgerEntrySchema } from './ledger-entry.schema';
import { LedgerPostingService } from './ledger-posting.service';
import { LedgerModule } from '../../ledger/ledger.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
    LedgerModule,   // provides AccountsService
  ],
  providers: [LedgerPostingService],
  exports: [LedgerPostingService],
})
export class LedgerPostingModule {}
