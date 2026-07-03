import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Account, AccountSchema } from './account.schema';
import { AccountsService } from './accounts.service';
import { AccountsController } from './accounts.controller';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';

@Module({
  imports: [MongooseModule.forFeature([{ name: Account.name, schema: AccountSchema }]), WorkspacesModule, SubscriptionsModule],
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService, MongooseModule],
})
export class LedgerModule {}
