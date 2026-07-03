import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Party, PartySchema } from './party.schema';
import { PartiesService } from './parties.service';
import { PartiesController } from './parties.controller';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';

@Module({
  imports: [MongooseModule.forFeature([{ name: Party.name, schema: PartySchema }]), WorkspacesModule, SubscriptionsModule],
  controllers: [PartiesController],
  providers: [PartiesService],
  exports: [PartiesService, MongooseModule],
})
export class PartiesModule {}
