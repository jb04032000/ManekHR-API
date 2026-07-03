import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Role } from './schemas/role.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { WorkspaceMember } from '../workspaces/schemas/workspace-member.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import {
  CreateRoleDto,
  UpdatePermissionsDto,
  PermissionDto,
  GrantedPermissionPathDto,
} from './dto/rbac.dto';
import { isWorkspaceOwner } from '../../common/utils/workspace-ownership.util';
import { applyPermissionOverrides, permissionsSatisfy } from '../../common/guards/roles.guard';
import { applyPathOverrides } from './permission-path-overrides';
import { pathGrantSatisfies } from './permission-matcher';
import type { GrantedPermission } from './permission-matcher';
import { assertViewEditCoherent } from './coherence';
import { assertDepsResolved } from './dep-resolver';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { diffGrants } from './grants-diff';
import { computePermissionVersion } from './permission-version';

// Hardcoded templates — presentation only, not persisted
const ROLE_TEMPLATES = [
  {
    name: 'Full Access',
    description: 'Complete control over attendance, team, and salary',
    permissions: {
      attendance: 'full',
      team: 'full',
      salary: 'full',
      shifts: 'view',
      roles: 'view',
      settings: 'view',
    },
  },
  {
    name: 'Financial Access',
    description: 'Full salary & payments, view-only for others',
    permissions: {
      attendance: 'view',
      team: 'view',
      salary: 'full',
      shifts: 'view',
      roles: 'none',
      settings: 'none',
    },
  },
  {
    name: 'Attendance Manager',
    description: 'Mark attendance and view team, no salary access',
    permissions: {
      attendance: 'full',
      team: 'view',
      salary: 'none',
      shifts: 'view',
      roles: 'none',
      settings: 'none',
    },
  },
  {
    name: 'View Only',
    description: 'Read-only access across all modules',
    permissions: {
      attendance: 'view',
      team: 'view',
      salary: 'none',
      shifts: 'view',
      roles: 'none',
      settings: 'none',
    },
  },
];

@Injectable()
export class RbacService {
  private readonly logger = new Logger(RbacService.name);

  constructor(
    @InjectModel(Role.name) private roleModel: Model<Role>,
    @InjectModel(Workspace.name) private workspaceModel: Model<Workspace>,
    @InjectModel(WorkspaceMember.name)
    private memberModel: Model<WorkspaceMember>,
    @InjectModel(TeamMember.name) private teamMemberModel: Model<TeamMember>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Resolve the calling user's effective permissions in a workspace.
   *
   * Mirrors RolesGuard's lookup chain: owner bypass first (returns isOwner:
   * true with empty permissions + paths — owner is implicit full access),
   * then membership lookup → role lookup → role permissions.
   *
   * Returns BOTH the legacy flat `permissions` and the Phase 1c hierarchical
   * `paths` (`role.permissionPaths` with per-member path overrides applied via
   * `applyPathOverrides` from `TeamMember.permissionPathOverrides`).
   * `RolesGuard` matches `@RequirePermission` routes against `paths`, legacy
   * `@RequirePermissions` routes against `permissions`. Powers the web `<Can>`
   * component via `GET /workspaces/:wsId/me/permissions`.
   *
   * Note: the legacy flat `permissionOverrides` on TeamMember still drive the
   * flat `permissions` array (via `applyPermissionOverrides`). The path-based
   * `permissionPathOverrides` drives the `paths` array exclusively.
   */
  async getMyPermissions(workspaceId: string, userId: string) {
    const workspace = await this.workspaceModel.findById(workspaceId).exec();
    if (!workspace) throw new NotFoundException('Workspace not found');

    // Caller's own team-directory row — surfaced as `teamMemberId` so the
    // web can resolve "which TeamMember am I?" ambiently (it is already
    // fetching /me/permissions on every page) instead of a heavier
    // dashboard round-trip. Drives the self-profile redirect (§7 B1) and
    // the self-edit SoD banner (§7 B3). `permissionOverrides` drives the
    // flat permissions merge; `permissionPathOverrides` drives the path merge.
    const ownTeamMember = await this.teamMemberModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        linkedUserId: new Types.ObjectId(userId),
        isDeleted: false,
      })
      .select('_id permissionOverrides permissionPathOverrides')
      .lean()
      .exec();
    const teamMemberId = ownTeamMember?._id ? String(ownTeamMember._id) : null;

    if (isWorkspaceOwner(workspace, userId)) {
      return {
        isOwner: true,
        teamMemberId,
        role: null as null | {
          id: string;
          name: string;
          isSystem: boolean;
          selfProfileEdit: 'allow' | 'block';
        },
        permissions: [] as Array<{
          module: string;
          actions: string[];
          actionScopes?: Array<'self' | 'all'>;
        }>,
        paths: [] as GrantedPermission[],
        // Owners have implicit full access — use a fixed sentinel so the
        // FE version never drifts on owner role changes (owners are exempt
        // from the RBAC role model entirely).
        permissionVersion: 'owner',
      };
    }

    const member = await this.memberModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        userId: new Types.ObjectId(userId),
        status: 'active',
      })
      .exec();

    if (!member) {
      // 2026-05-22 diagnostic: when the active-membership lookup misses, also
      // probe by userId only and by workspaceId+userId regardless of status,
      // so the log tells us whether the row exists in a different state
      // (still 'invited'? 'declined'? 'removed'?) or under a different
      // workspace. Wrapped in try/catch so the diagnostic itself can never
      // mask the underlying ForbiddenException response.
      try {
        const anyStatus = await this.memberModel
          .findOne({
            workspaceId: new Types.ObjectId(workspaceId),
            userId: new Types.ObjectId(userId),
          })
          .lean()
          .exec();
        if (anyStatus) {
          this.logger.warn(
            `getMyPermissions: membership exists but status=${anyStatus.status} ` +
              `workspace=${workspaceId} user=${userId}`,
          );
        } else {
          const userOnly = await this.memberModel
            .find({ userId: new Types.ObjectId(userId), status: 'active' })
            .select('_id workspaceId')
            .lean()
            .exec();
          this.logger.warn(
            `getMyPermissions: no membership in workspace=${workspaceId} for user=${userId}. ` +
              `User has ${userOnly.length} active memberships elsewhere: ` +
              userOnly.map((m) => String(m.workspaceId)).join(','),
          );
        }
      } catch (e) {
        this.logger.warn(`getMyPermissions diagnostic probe failed: ${(e as Error).message}`);
      }
      throw new ForbiddenException('You are not a member of this workspace');
    }

    if (!member.roleId) {
      return {
        isOwner: false,
        teamMemberId,
        role: null,
        permissions: [],
        paths: [],
        permissionVersion: computePermissionVersion({ roleId: null }),
      };
    }

    // member.roleId is typed `Role | Types.ObjectId` per the schema's
    // populate-aware annotation. This codepath does not call .populate(),
    // so the runtime value is always an ObjectId. Narrow to satisfy
    // `no-base-to-string` (the union member `Role` does not override
    // toString).
    const roleIdStr = (member.roleId as Types.ObjectId).toString();
    // 2026-05-22: `.lean()` so role.permissions / role.permissionPaths feed
    // computePermissionVersion as plain POJOs. The PermissionVersionInterceptor
    // also fetches the role with `.lean()`. Without matching shapes, the
    // service spread Mongoose subdocuments while the interceptor spread
    // POJOs, producing different JSON.stringify output for the same data,
    // different hashes, and an infinite FE invalidate / refetch loop on
    // the dashboard for freshly-invited members.
    const role = await this.roleModel.findById(new Types.ObjectId(roleIdStr)).lean().exec();

    if (!role) {
      return {
        isOwner: false,
        teamMemberId,
        role: null,
        permissions: [],
        paths: [],
        permissionVersion: computePermissionVersion({ roleId: roleIdStr }),
      };
    }

    // Merge per-member permission overrides on top of the role bundle so the
    // web permission state (the <Can> component / nav filtering) matches
    // exactly what RolesGuard enforces server-side. RolesGuard runs this same
    // merge — returning raw role permissions here would let the UI diverge
    // from the API (e.g. hide an action the member was actually granted via
    // an override, or show one that was denied). `ownTeamMember` (resolved
    // up front for `teamMemberId`) carries the override rows.
    const effectivePermissions = applyPermissionOverrides(
      role.permissions,
      ownTeamMember?.permissionOverrides ?? [],
    );
    // Phase 1c — hierarchical path grants for `@RequirePermission` routes:
    // `role.permissionPaths` with the per-member path overrides from
    // `TeamMember.permissionPathOverrides` applied via `applyPathOverrides`.
    // This is the canonical override model — force-allow / force-deny at the
    // granular path level, matching exactly what CallerScopeService and
    // RolesGuard enforce server-side.
    const effectivePaths = applyPathOverrides(
      role.permissionPaths ?? [],
      ownTeamMember?.permissionPathOverrides ?? [],
    );

    const permissionVersion = computePermissionVersion({
      roleId: roleIdStr,
      rolePermissions: role.permissions,
      rolePermissionPaths: role.permissionPaths,
      memberPermissionOverrides: ownTeamMember?.permissionOverrides,
      memberPermissionPathOverrides: ownTeamMember?.permissionPathOverrides,
    });

    return {
      isOwner: false,
      teamMemberId,
      role: {
        id: role._id.toString(),
        name: role.name,
        isSystem: role.isSystem,
        selfProfileEdit: role.selfProfileEdit ?? 'allow',
      },
      permissions: effectivePermissions.map((p) => ({
        module: p.module,
        actions: p.actions,
        actionScopes: p.actionScopes,
      })),
      paths: effectivePaths,
      permissionVersion,
    };
  }

  /**
   * Get all custom roles for a workspace, with memberCount computed per role.
   */
  async findAll(workspaceId: string) {
    const roles = await this.roleModel
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .exec();

    // Aggregate team member counts per rbacRoleId in one query
    const memberCounts = await this.teamMemberModel.aggregate([
      {
        $match: {
          $or: [{ workspaceId: new Types.ObjectId(workspaceId) }, { workspaceId: workspaceId }],
          isActive: true,
          rbacRoleId: { $exists: true, $ne: null },
        },
      },
      { $group: { _id: '$rbacRoleId', count: { $sum: 1 } } },
    ]);

    const countMap: Record<string, number> = {};
    memberCounts.forEach((mc: { _id: Types.ObjectId | null; count: number }) => {
      if (mc._id) countMap[mc._id.toString()] = mc.count;
    });

    const result = roles.map((role) => ({
      _id: role._id,
      name: role.name,
      description: role.description,
      color: role.color,
      isSystem: role.isSystem,
      permissions: role.permissions,
      // Phase 1d — path grants MUST round-trip so the override matrix can
      // render "Inherit role allow @<scope>" tags on every leaf the role
      // already grants. Without this, the matrix shows every cell as
      // ungranted; the owner clicks "allow" thinking they're granting it,
      // but the cell-toggle defaults to `scope: 'self'` and the saved
      // override DOWNGRADES the role's @all grant via `applyPathOverrides`.
      // `findOne` already returns this field — `findAll` was the lone hole.
      permissionPaths: role.permissionPaths ?? [],
      workspaceId: role.workspaceId,
      createdBy: role.createdBy,
      memberCount: countMap[role._id.toString()] || 0,
    }));

    return result;
  }

  /**
   * Resolve the calling user's effective permission rows in a workspace —
   * the same lookup chain RolesGuard runs (membership → assigned Role →
   * per-member TeamMember.permissionOverrides / permissionPathOverrides merge).
   * Used as the actor's permission ceiling when authoring/editing roles.
   *
   * Returns `null` when the actor is the workspace owner — the caller treats
   * a null ceiling as "unlimited" and skips both ceiling checks (owner has
   * implicit full access). Returns `{ permissions: [], permissionPaths: [] }`
   * for a member with no role / no permissions.
   */
  private async resolveActorPermissions(
    workspace: Workspace,
    userId: string,
  ): Promise<{
    permissions: Array<{ module: string; actions: string[]; actionScopes?: ('self' | 'all')[] }>;
    permissionPaths: GrantedPermission[];
  } | null> {
    if (isWorkspaceOwner(workspace, userId)) return null;

    const workspaceId = String(workspace._id);
    const member = await this.memberModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        userId: new Types.ObjectId(userId),
        status: 'active',
      })
      .exec();
    if (!member || !member.roleId) return { permissions: [], permissionPaths: [] };

    const roleIdStr = (member.roleId as Types.ObjectId).toString();
    const role = await this.roleModel.findById(new Types.ObjectId(roleIdStr)).exec();
    if (!role) return { permissions: [], permissionPaths: [] };

    const ownTeamMember = await this.teamMemberModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        linkedUserId: new Types.ObjectId(userId),
        isDeleted: false,
      })
      .select('permissionOverrides permissionPathOverrides')
      .lean()
      .exec();

    return {
      permissions: applyPermissionOverrides(
        role.permissions,
        ownTeamMember?.permissionOverrides ?? [],
      ),
      permissionPaths: applyPathOverrides(
        role.permissionPaths ?? [],
        ownTeamMember?.permissionPathOverrides ?? [],
      ),
    };
  }

  /**
   * Permission-ceiling check (security — R-6). Throws ForbiddenException when
   * the actor attempts to grant a (module, action, scope) tuple they do not
   * themselves hold. The workspace owner bypasses the ceiling entirely
   * (`actorPermissions === null`). Without this, a non-owner holding
   * `roles.create`/`roles.edit` could mint a role granting permissions far
   * beyond their own — a privilege-escalation path.
   */
  private assertWithinCeiling(
    actorPermissions: Array<{
      module: string;
      actions: string[];
      actionScopes?: ('self' | 'all')[];
    }> | null,
    requestedPermissions: PermissionDto[] | undefined,
  ): void {
    if (actorPermissions === null) return; // owner — unlimited
    if (!requestedPermissions) return;

    for (const perm of requestedPermissions) {
      perm.actions.forEach((action, idx) => {
        // The granted scope the actor must satisfy to confer this tuple.
        // A missing scope on the requested grant falls back to 'self'
        // (least-privilege), matching RolesGuard's stored-grant default.
        const scope = perm.actionScopes?.[idx] ?? 'self';
        const held = permissionsSatisfy(actorPermissions, {
          module: perm.module,
          action,
          scope,
        });
        if (!held) {
          throw new ForbiddenException(
            `You cannot grant a permission you do not hold: ${perm.module}:${action} (${scope})`,
          );
        }
      });
    }
  }

  /**
   * Permission-ceiling check for hierarchical path grants (security). A
   * non-owner cannot author/edit a role granting a registry path at a scope
   * they do not themselves hold. Owner bypasses (`actorPaths === null`).
   */
  private assertPathsWithinCeiling(
    actorPaths: GrantedPermission[] | null,
    requestedPaths: GrantedPermissionPathDto[] | undefined,
  ): void {
    if (actorPaths === null) return; // owner — unlimited
    if (!requestedPaths) return;
    for (const req of requestedPaths) {
      if (!pathGrantSatisfies(actorPaths, { path: req.path, scope: req.scope })) {
        throw new ForbiddenException(
          `You cannot grant a permission you do not hold: ${req.path} (${req.scope})`,
        );
      }
    }
  }

  /**
   * Create a custom role within a workspace.
   */
  async create(workspaceId: string, userId: string, createDto: CreateRoleDto) {
    const workspace = await this.workspaceModel.findById(workspaceId).exec();
    if (!workspace) throw new NotFoundException('Workspace not found');

    // Permission ceiling — a non-owner cannot author a role granting more
    // than they themselves hold (flat permissions or path grants), owner bypasses.
    const actor = await this.resolveActorPermissions(workspace, userId);
    this.assertWithinCeiling(actor?.permissions ?? null, createDto.permissions);
    this.assertPathsWithinCeiling(actor?.permissionPaths ?? null, createDto.permissionPaths);

    // Phase 1d — invariants: view-edit coherence + cross-leaf deps. Industry
    // rule (Rippling/Bamboo): edit logically requires view; Workday/Deel:
    // `member.delete` cannot exist without `directory.view`.
    const newPaths = createDto.permissionPaths ?? [];
    assertViewEditCoherent(newPaths);
    assertDepsResolved(newPaths);

    const role = new this.roleModel({
      ...createDto,
      workspaceId: new Types.ObjectId(workspaceId),
      createdBy: new Types.ObjectId(userId),
      isSystem: false,
      permissionPaths: createDto.permissionPaths ?? [], // default to [] when the caller omits the optional field
    });
    const saved = await role.save();

    void this.auditService
      .logEvent({
        workspaceId,
        module: AppModuleEnum.ROLES,
        entityType: 'role',
        entityId: String(saved._id),
        action: 'rbac.role_permissions_changed',
        actorId: userId,
        meta: {
          op: 'create',
          name: saved.name,
          pathDiff: diffGrants([], saved.permissionPaths ?? []),
        },
      })
      .catch(() => {
        // intentionally swallowed
      });

    return saved;
  }

  /**
   * Find a single role by ID, scoped to a workspace.
   */
  async findById(workspaceId: string, roleId: string) {
    const role = await this.roleModel
      .findOne({
        _id: new Types.ObjectId(roleId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();

    if (!role) throw new NotFoundException('Role not found');

    // Compute memberCount from TeamMember collection via rbacRoleId
    const memberCount = await this.teamMemberModel.countDocuments({
      $or: [{ workspaceId: new Types.ObjectId(workspaceId) }, { workspaceId: workspaceId }],
      rbacRoleId: role._id,
      isActive: true,
    });

    return {
      _id: role._id,
      name: role.name,
      description: role.description,
      color: role.color,
      isSystem: role.isSystem,
      permissions: role.permissions,
      permissionPaths: role.permissionPaths,
      workspaceId: role.workspaceId,
      createdBy: role.createdBy,
      memberCount,
    };
  }

  /**
   * Update a custom role's name, description, color, or permissions.
   */
  async update(
    workspaceId: string,
    roleId: string,
    userId: string,
    updateDto: UpdatePermissionsDto,
  ) {
    const workspace = await this.workspaceModel.findById(workspaceId).exec();
    if (!workspace) throw new NotFoundException('Workspace not found');

    const role = await this.roleModel
      .findOne({
        _id: new Types.ObjectId(roleId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (!role) throw new NotFoundException('Role not found');

    const actor = await this.resolveActorPermissions(workspace, userId);

    // System-role protection — only the owner (null ceiling) may edit a
    // seeded system role (Karigar/Manager/HR). A non-owner editing these
    // could silently break the presets the product relies on.
    if (role.isSystem && actor !== null) {
      throw new ForbiddenException('Only the workspace owner can edit a system role');
    }

    // Permission ceiling — a non-owner cannot escalate a role's permissions
    // beyond what they themselves hold (flat or path grants); owner bypasses.
    this.assertWithinCeiling(actor?.permissions ?? null, updateDto.permissions);
    this.assertPathsWithinCeiling(actor?.permissionPaths ?? null, updateDto.permissionPaths);

    // Phase 1d — invariants on the NEW path set (skip when the partial update
    // omits `permissionPaths`).
    if (updateDto.permissionPaths !== undefined) {
      assertViewEditCoherent(updateDto.permissionPaths);
      assertDepsResolved(updateDto.permissionPaths);
    }

    // Capture BEFORE state for audit diff (only when permissionPaths is part of update).
    const prevPaths: GrantedPermission[] = role.permissionPaths ?? [];

    Object.assign(role, updateDto);
    const saved = await role.save();

    if (updateDto.permissionPaths !== undefined) {
      void this.auditService
        .logEvent({
          workspaceId,
          module: AppModuleEnum.ROLES,
          entityType: 'role',
          entityId: String(saved._id),
          action: 'rbac.role_permissions_changed',
          actorId: userId,
          meta: {
            op: 'update',
            name: saved.name,
            pathDiff: diffGrants(prevPaths, saved.permissionPaths ?? []),
          },
        })
        .catch(() => {
          // intentionally swallowed
        });
    }

    return saved;
  }

  /**
   * Delete a custom role. Fails if members are still assigned.
   */
  async remove(workspaceId: string, roleId: string, userId: string) {
    const workspace = await this.workspaceModel.findById(workspaceId).exec();
    if (!workspace) throw new NotFoundException('Workspace not found');

    const role = await this.roleModel
      .findOne({
        _id: new Types.ObjectId(roleId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (!role) throw new NotFoundException('Role not found');

    // System-role protection — only the owner may delete a seeded system role.
    // (Owner-can-delete-built-ins is intentional, RBAC-hardening owner decision:
    //  no permanent system-role block is added this pass.)
    if (role.isSystem && !isWorkspaceOwner(workspace, userId)) {
      throw new ForbiddenException('Only the workspace owner can delete a system role');
    }

    // Tenant-isolation: count members assigned to this role WITHIN this workspace
    // only. A `roleId` is already a workspace-scoped FK (a role's _id is only ever
    // assigned to members of its own workspace), so the prior unscoped count was
    // safe — but ANDing `workspaceId` makes the cross-tenant guarantee explicit
    // and defends against a future code path that reuses an id across workspaces
    // (RBAC-hardening Pillar 2). The count spans ALL statuses (active + removed):
    // a removed member's WorkspaceMember.roleId still points at this role and
    // remains part of the audit trail, so deleting the role would orphan that FK.
    const membersCount = await this.memberModel
      .countDocuments({
        roleId: new Types.ObjectId(roleId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (membersCount > 0) {
      throw new BadRequestException(
        `Cannot delete role: ${membersCount} members are currently assigned to it`,
      );
    }

    // Hard-delete (not soft-delete) is correct here: a custom Role is pure
    // workspace CONFIGURATION — it holds no personal data, carries no statutory
    // retention requirement, and an orphaned custom role would only pollute the
    // role-matrix UI. The member-count guard above already protects every role
    // that is still referenced (active or removed). System-role presets are
    // never reached here for non-owners (guard above); the owner deleting one is
    // an accepted, owner-chosen behaviour. (RBAC-hardening Pillar 1.)
    await role.deleteOne();
  }

  /**
   * Find a role by ID (for guard lookups).
   */
  async findRoleById(roleId: string): Promise<Role | null> {
    return this.roleModel.findById(roleId).exec();
  }

  /**
   * Return hardcoded role templates.
   */
  getTemplates() {
    return ROLE_TEMPLATES;
  }
}
