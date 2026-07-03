import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TeamMember } from '../modules/team/schemas/team-member.schema';
import { WorkspaceMember } from '../modules/workspaces/schemas/workspace-member.schema';

interface MigrationResult {
  invitesBackfilled: number;
  invitesSkipped: number;
  activeBackfilled: number;
  activeSkipped: number;
  errors: string[];
}

/**
 * Wave 2 invite consolidation — backfill (W2.8, 2026-05-10).
 *
 * For every existing TeamMember that holds an app-access token (legacy
 * grant-access flow) or has hasAppAccess=true, ensure a corresponding
 * WorkspaceMember row exists so the new POST /invites/:token/accept and
 * RolesGuard lookup paths work uniformly.
 *
 * Two backfill cases:
 *   1. Pending invite: TeamMember.appAccessInviteToken / Hash / Expiry set,
 *      hasAppAccess=false. Create a WorkspaceMember(status='invited',
 *      linkedTeamMemberId, inviteTokenHash, inviteExpiry, roleId).
 *   2. Active access: TeamMember.hasAppAccess=true + linkedUserId. Ensure
 *      a WorkspaceMember(status='active', linkedTeamMemberId, userId,
 *      roleId) exists. If one already exists with the same linkedTeamMemberId
 *      we update fields rather than insert a duplicate.
 *
 * Both branches also write back TeamMember.linkedWorkspaceMemberId so the
 * forward-link is set for new code paths.
 *
 * Idempotent — safe to re-run on every boot. Runs unconditionally (mirrors
 * the pro→growth pattern) because it is a true forward-only migration, not
 * a conditional seed.
 */
@Injectable()
export class MigrateTeamAppAccessToWorkspaceMembersService {
  private readonly logger = new Logger(MigrateTeamAppAccessToWorkspaceMembersService.name);

  constructor(
    @InjectModel(TeamMember.name) private teamModel: Model<TeamMember>,
    @InjectModel(WorkspaceMember.name)
    private memberModel: Model<WorkspaceMember>,
  ) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      invitesBackfilled: 0,
      invitesSkipped: 0,
      activeBackfilled: 0,
      activeSkipped: 0,
      errors: [],
    };

    // ── Case 1 — pending invites ────────────────────────────────────────
    const pendingTeamMembers = await this.teamModel
      .find({
        appAccessInviteTokenHash: { $exists: true, $ne: null },
        hasAppAccess: { $ne: true },
        // Don't migrate twice — the backfill writes linkedWorkspaceMemberId.
        $or: [{ linkedWorkspaceMemberId: { $exists: false } }, { linkedWorkspaceMemberId: null }],
      })
      .exec();

    for (const tm of pendingTeamMembers) {
      try {
        const workspaceId = tm.workspaceId as Types.ObjectId;
        const linkedTeamMemberId = tm._id;

        // If a corresponding WorkspaceMember already exists, skip.
        const existing = await this.memberModel
          .findOne({
            workspaceId,
            linkedTeamMemberId,
            status: { $in: ['invited', 'active'] },
          })
          .exec();
        if (existing) {
          // Forward-link still needs writing back.
          if (!tm.linkedWorkspaceMemberId) {
            tm.linkedWorkspaceMemberId = existing._id;
            await tm.save();
          }
          result.invitesSkipped++;
          continue;
        }

        const inviteeIdentifier = tm.email || tm.mobile || null;
        const inviteeType = tm.email ? 'email' : 'mobile';

        const created = await this.memberModel.create({
          workspaceId,
          userId: tm.linkedUserId ?? null,
          roleId: tm.rbacRoleId ?? null,
          status: 'invited',
          invitedBy: tm.appAccessGrantedBy ?? undefined,
          inviteTokenHash: tm.appAccessInviteTokenHash,
          inviteExpiry: tm.appAccessInviteExpiry,
          inviteeIdentifier: inviteeIdentifier ?? undefined,
          inviteeType,
          linkedTeamMemberId,
        });

        tm.linkedWorkspaceMemberId = created._id;
        await tm.save();
        result.invitesBackfilled++;
      } catch (err) {
        const message = `pending TeamMember ${String(tm._id)}: ${(err as Error)?.message ?? err}`;
        result.errors.push(message);
        this.logger.warn(`Backfill error — ${message}`);
      }
    }

    // ── Case 2 — active access ──────────────────────────────────────────
    const activeTeamMembers = await this.teamModel
      .find({
        hasAppAccess: true,
        linkedUserId: { $exists: true, $ne: null },
        $or: [{ linkedWorkspaceMemberId: { $exists: false } }, { linkedWorkspaceMemberId: null }],
      })
      .exec();

    for (const tm of activeTeamMembers) {
      try {
        const workspaceId = tm.workspaceId as Types.ObjectId;
        const linkedTeamMemberId = tm._id;
        const userId = tm.linkedUserId as Types.ObjectId;

        // Prefer an existing membership row keyed by (workspace, user) — the
        // canonical unique pair. If found, just attach the team-member link.
        const existing = await this.memberModel
          .findOne({
            workspaceId,
            userId,
            status: { $ne: 'removed' },
          })
          .exec();

        if (existing) {
          let dirty = false;
          if (!existing.linkedTeamMemberId) {
            existing.linkedTeamMemberId = linkedTeamMemberId;
            dirty = true;
          }
          if (!existing.roleId && tm.rbacRoleId) {
            existing.roleId = tm.rbacRoleId;
            dirty = true;
          }
          if (existing.status !== 'active') {
            existing.status = 'active';
            dirty = true;
          }
          if (dirty) await existing.save();
          tm.linkedWorkspaceMemberId = existing._id;
          await tm.save();
          result.activeSkipped++;
          continue;
        }

        const created = await this.memberModel.create({
          workspaceId,
          userId,
          roleId: tm.rbacRoleId ?? null,
          status: 'active',
          invitedBy: tm.appAccessGrantedBy ?? undefined,
          joinedAt: tm.appAccessGrantedAt ?? new Date(),
          linkedTeamMemberId,
        });

        tm.linkedWorkspaceMemberId = created._id;
        await tm.save();
        result.activeBackfilled++;
      } catch (err) {
        const message = `active TeamMember ${String(tm._id)}: ${(err as Error)?.message ?? err}`;
        result.errors.push(message);
        this.logger.warn(`Backfill error — ${message}`);
      }
    }

    return result;
  }
}
