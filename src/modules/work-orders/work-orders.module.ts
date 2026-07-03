import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WorkOrder, WorkOrderSchema } from './schemas/work-order.schema';
import { ShopFloorConfig, ShopFloorConfigSchema } from './schemas/shop-floor-config.schema';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';
import { ShopFloorConfigService } from './shop-floor-config.service';
import { MachinesModule } from '../machines/machines.module';
import { LocationsModule } from '../locations/locations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { TeamModule } from '../team/team.module';
import { UsersModule } from '../users/users.module';

// WorkOrdersModule — production work orders + step DAG for the web Shop
// Floor Control page (app/dashboard/machines/shop-floor). Mirrors the
// DowntimeModule wiring: MachinesModule re-exports the Machine model,
// WorkspacesModule provides WorkspaceCounterService (WO-NNN codes),
// TeamModule re-exports the TeamMember model for assignee validation, and
// UsersModule re-exports the User model for the entry byName snapshot.
//
// Also hosts ShopFloorConfig (floors + people per location) for the web Shop
// Floor Setup wizard — LocationsModule re-exports the Location model for the
// upsert's workspace guard. Machine→floor stays on Machine.floorTag.
//
// NOTE: ResourceScopesModule is @Global() and registered in AppModule — its
// ResourceScopeGuard is available here without an explicit import.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WorkOrder.name, schema: WorkOrderSchema },
      { name: ShopFloorConfig.name, schema: ShopFloorConfigSchema },
    ]),
    MachinesModule,
    LocationsModule,
    WorkspacesModule,
    SubscriptionsModule,
    TeamModule,
    UsersModule,
  ],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService, ShopFloorConfigService],
  exports: [WorkOrdersService, ShopFloorConfigService],
})
export class WorkOrdersModule {}
