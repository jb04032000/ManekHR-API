import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Item, ItemSchema } from './item.schema';
import { ItemsService } from './items.service';
import { ItemsController } from './items.controller';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';

@Module({
  imports: [MongooseModule.forFeature([{ name: Item.name, schema: ItemSchema }]), WorkspacesModule, SubscriptionsModule],
  controllers: [ItemsController],
  providers: [ItemsService],
  exports: [ItemsService, MongooseModule],
})
export class ItemsModule {}
