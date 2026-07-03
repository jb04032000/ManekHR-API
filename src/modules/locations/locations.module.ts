import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LocationsService } from './locations.service';
import { LocationsController } from './locations.controller';
import { Location, LocationSchema } from './schemas/location.schema';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Location.name, schema: LocationSchema },
    ]),
    WorkspacesModule,
    SubscriptionsModule,
  ],
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService, MongooseModule],
})
export class LocationsModule {}
