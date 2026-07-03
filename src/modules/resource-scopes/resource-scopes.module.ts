import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ResourceScopesService } from './resource-scopes.service';
import { ResourceScopesController } from './resource-scopes.controller';
import {
  ResourceScope,
  ResourceScopeSchema,
} from './schemas/resource-scope.schema';
import { ResourceScopeGuard } from '../../common/guards/resource-scope.guard';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ResourceScope.name, schema: ResourceScopeSchema },
    ]),
    WorkspacesModule,
    SubscriptionsModule,
  ],
  controllers: [ResourceScopesController],
  providers: [ResourceScopesService, ResourceScopeGuard],
  exports: [ResourceScopesService, ResourceScopeGuard, MongooseModule],
})
export class ResourceScopesModule {}
