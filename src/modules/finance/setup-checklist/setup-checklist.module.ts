import { Module } from '@nestjs/common';
import { SetupChecklistService } from './setup-checklist.service';
import { SetupChecklistController } from './setup-checklist.controller';
import { FirmsModule } from '../firms/firms.module';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';

@Module({
  imports: [FirmsModule, WorkspacesModule, SubscriptionsModule],
  controllers: [SetupChecklistController],
  providers: [SetupChecklistService],
  exports: [SetupChecklistService],
})
export class SetupChecklistModule {}
