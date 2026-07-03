import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductionLog, ProductionLogSchema } from './schemas/production-log.schema';
import { ProductionLogsService } from './production-logs.service';
import { ProductionLogsController } from './production-logs.controller';
import { MachinesModule } from '../machines/machines.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { TeamModule } from '../team/team.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SalaryModule } from '../salary/salary.module';

// NOTE: ResourceScopesModule is @Global() and registered in AppModule — its
// ResourceScopeGuard + ResourceScopesService are available globally without
// importing ResourceScopesModule here.

// NOTE: Machine, MachineShiftAssignment, and Workspace model tokens are provided
// via MachinesModule.exports[MongooseModule] and WorkspacesModule.exports[MongooseModule].
// No additional forFeature() calls needed here — both modules already export their
// full MongooseModule registrations (verified from machines.module.ts + workspaces.module.ts).

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ProductionLog.name, schema: ProductionLogSchema },
    ]),
    forwardRef(() => MachinesModule),
    WorkspacesModule,
    forwardRef(() => TeamModule),
    SubscriptionsModule,
    forwardRef(() => SalaryModule),
  ],
  controllers: [ProductionLogsController],
  providers: [ProductionLogsService],
  exports: [ProductionLogsService, MongooseModule],
})
export class ProductionLogsModule {}
