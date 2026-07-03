import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GstinService } from './gstin.service';
import { GstinController } from './gstin.controller';
import { SurepassProvider } from './providers/surepass.provider';
import { GstinLookupCache, GstinLookupCacheSchema } from './gstin-lookup-cache.schema';
import { FirmsModule } from '../firms/firms.module';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: GstinLookupCache.name, schema: GstinLookupCacheSchema }]),
    FirmsModule,
    WorkspacesModule,
    SubscriptionsModule,
  ],
  controllers: [GstinController],
  providers: [GstinService, SurepassProvider],
  exports: [GstinService, SurepassProvider],
})
export class GstinModule {}
