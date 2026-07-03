import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RbacService } from './rbac.service';
import { RbacController } from './rbac.controller';
import { MeController } from './me.controller';
import { RbacRegistryController } from './rbac-registry.controller';
import { Role, RoleSchema } from './schemas/role.schema';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TeamMember, TeamMemberSchema } from '../team/schemas/team-member.schema';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { RoleSeederService } from './role-seeder.service';
import { AuditModule } from '../audit/audit.module';
import { RbacOverrideRetentionCron } from './crons/rbac-override-retention.cron';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Role.name, schema: RoleSchema },
      { name: TeamMember.name, schema: TeamMemberSchema },
    ]),
    // @Global() WorkspacesModule exports its MongooseModule, so the Workspace
    // model is available here for the retention cron's per-workspace loop (same
    // wiring the bills retention cron relies on).
    WorkspacesModule,
    SubscriptionsModule,
    AuditModule,
  ],
  controllers: [RbacController, MeController, RbacRegistryController],
  providers: [
    RbacService,
    RolesGuard,
    RoleSeederService,
    // RBAC hardening Pillar 1: system-only retention cleaner for per-member
    // access-control overrides (OFF by default). SingleFlightService is provided
    // by the @Global() scheduler module.
    RbacOverrideRetentionCron,
  ],
  exports: [RbacService, RolesGuard, RoleSeederService, MongooseModule],
})
export class RbacModule {}
