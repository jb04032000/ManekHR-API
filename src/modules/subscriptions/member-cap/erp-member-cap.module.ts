import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TeamMember, TeamMemberSchema } from '../../team/schemas/team-member.schema';
import { Workspace, WorkspaceSchema } from '../../workspaces/schemas/workspace.schema';
import { Subscription, SubscriptionSchema } from '../schemas/subscription.schema';
import { ErpMemberCapState, ErpMemberCapStateSchema } from './schemas/erp-member-cap-state.schema';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ErpMemberCapService } from './erp-member-cap.service';
import { ErpMemberCapReconcileCron } from './erp-member-cap.cron';

/**
 * ERP member-cap module — read-time grandfathering of a workspace's roster
 * against its plan's `maxMembersPerWorkspace` (lapsed-trial downgrade to Free).
 *
 * Provides `ErpMemberCapService`: computes the read-time ALLOWED member set
 * (owner-first, oldest-survive) and maintains the per-workspace grace clock +
 * once-per-episode over-cap notice. The allowed set is COMPUTED, never stored —
 * mirrors the Connect over-limit policy (docs/connect/2026-06-12-...).
 *
 * Registers the three read schemas (TeamMember / Workspace / Subscription) +
 * its own state schema LOCALLY (standard Nest — shares the underlying
 * collection), and imports NotificationsModule for the entry notice. It injects
 * MODELS directly (not TeamService / SubscriptionsService) so the consumer →
 * service dependency direction stays acyclic: Team / Salary / Attendance import
 * THIS module, and this module imports none of them.
 *
 * Exported so the Phase-6 read consumers (Team / Salary / Attendance) can inject
 * `ErpMemberCapService`.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TeamMember.name, schema: TeamMemberSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: ErpMemberCapState.name, schema: ErpMemberCapStateSchema },
    ]),
    NotificationsModule,
  ],
  providers: [ErpMemberCapService, ErpMemberCapReconcileCron],
  exports: [ErpMemberCapService],
})
export class ErpMemberCapModule {}
