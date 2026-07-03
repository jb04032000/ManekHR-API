import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashRegister, CashRegisterSchema } from './cash-register.schema';
import { CashRegistersService } from './cash-registers.service';
import { CashRegistersController } from './cash-registers.controller';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';
import { LedgerModule } from '../ledger/ledger.module';
import { JournalVouchersModule } from '../journal-vouchers/journal-vouchers.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CashRegister.name, schema: CashRegisterSchema }]),
    WorkspacesModule,
    SubscriptionsModule,
    LedgerModule,                               // provides AccountsService
    forwardRef(() => JournalVouchersModule),    // forwardRef: JournalVouchersModule imports CashRegistersModule (circular)
  ],
  controllers: [CashRegistersController],
  providers: [CashRegistersService],
  exports: [CashRegistersService, MongooseModule],
})
export class CashRegistersModule {}
