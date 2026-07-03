import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import type { PermissionScope } from '../modules/rbac/schemas/role.schema';
import { TeamMember } from '../modules/team/schemas/team-member.schema';
import { AppModule, ModuleAction } from '../common/enums/modules.enum';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  membersScanned: number;
  membersUpdated: number;
  errors: string[];
}

/**
 * G2 / A+ (2026-05-24) — retire `self` scope on attendance mark + edit.
 *
 * These two actions became manager-only (`scoped: false` in the registry;
 * routes require `'all'`). Members self-serve via `selfPunch.create@self`
 * (clock-in) and correct via `regularization.request.apply@self`
 * (manager-approved). A direct self status-set/edit has no member UI and
 * would bypass the punch/approval trail (segregation of duties).
 *
 * This migration STRIPS the now-invalid self grants from existing data so the
 * permission matrix stops rendering them (a leftover `mark@self` grant would
 * otherwise show as a granted, all-level capability and could escalate on a
 * matrix re-save):
 *
 *   1. `Role.permissions` (flat) — drop `mark`/`edit` whose `actionScopes`
 *      entry is `'self'` from the attendance grant. `'all'` grants
 *      (Manager / HR) are kept untouched.
 *   2. `Role.permissionPaths` (path) — drop
 *      `attendance.record.mark|edit` grants at `scope: 'self'`.
 *   3. `TeamMember.permissionPathOverrides` — drop force-ALLOW
 *      (`allowed: true`) self overrides of those paths. Deny overrides
 *      (`allowed: false`) and `'all'` allows are preserved.
 *
 * Surgical + idempotent: only self-scoped mark/edit grants are removed; every
 * other grant is left exactly as-is. A re-run finds nothing and writes nothing.
 *
 * Ordering — runs AFTER `BackfillRoleAttendancePermissionPathsService`: that
 * union-merge can re-derive `mark@self` onto a custom role's `permissionPaths`
 * from its flat `permissions`. Stripping BOTH stores here makes the system
 * converge — the next boot's merge sees no self grant in flat and re-adds
 * nothing.
 */
@Injectable()
export class StripAttendanceMarkEditSelfScopeService {
  private readonly logger = new Logger(StripAttendanceMarkEditSelfScopeService.name);

  /** Registry paths whose `self` scope was retired in G2/A+. */
  private static readonly RETIRED_PATHS: readonly string[] = [
    'attendance.record.mark',
    'attendance.record.edit',
  ];
  /** Flat-store action twins of the retired paths. */
  private static readonly RETIRED_ACTIONS: readonly ModuleAction[] = [
    ModuleAction.MARK,
    ModuleAction.EDIT,
  ];

  constructor(
    @InjectModel(Role.name) private readonly roleModel: Model<Role>,
    @InjectModel(TeamMember.name) private readonly teamMemberModel: Model<TeamMember>,
  ) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      rolesScanned: 0,
      rolesUpdated: 0,
      membersScanned: 0,
      membersUpdated: 0,
      errors: [],
    };

    const roles = await this.roleModel.find({}).exec();
    for (const role of roles) {
      result.rolesScanned++;
      try {
        let changed = false;

        // 1. Flat permissions — drop self-scoped mark/edit from attendance.
        const nextPermissions = (role.permissions ?? []).map((perm) => {
          if (perm.module !== AppModule.ATTENDANCE) {
            return { module: perm.module, actions: perm.actions, actionScopes: perm.actionScopes };
          }
          const actions = perm.actions ?? [];
          const scopes = Array.isArray(perm.actionScopes) ? perm.actionScopes : [];
          const keptActions: ModuleAction[] = [];
          const keptScopes: PermissionScope[] = [];
          for (let i = 0; i < actions.length; i++) {
            const scope: PermissionScope = scopes[i] ?? 'self';
            const retired =
              StripAttendanceMarkEditSelfScopeService.RETIRED_ACTIONS.includes(actions[i]) &&
              scope === 'self';
            if (retired) {
              changed = true;
              continue;
            }
            keptActions.push(actions[i]);
            keptScopes.push(scope);
          }
          return { module: perm.module, actions: keptActions, actionScopes: keptScopes };
        });

        // 2. Path grants — drop self-scoped mark/edit.
        const existingPaths = Array.isArray(role.permissionPaths) ? role.permissionPaths : [];
        const nextPaths = existingPaths.filter(
          (g) =>
            !(
              StripAttendanceMarkEditSelfScopeService.RETIRED_PATHS.includes(g.path) &&
              (g.scope ?? 'self') === 'self'
            ),
        );
        if (nextPaths.length !== existingPaths.length) changed = true;

        if (!changed) continue;

        await this.roleModel.updateOne(
          { _id: role._id },
          { $set: { permissions: nextPermissions, permissionPaths: nextPaths } },
        );
        result.rolesUpdated++;
      } catch (err) {
        const message = `role ${String(role._id)} (${role.name}): ${
          (err as Error)?.message ?? err
        }`;
        result.errors.push(message);
        this.logger.warn(`strip mark/edit self-scope (role) error — ${message}`);
      }
    }

    // 3. Member path overrides — drop force-ALLOW self overrides of mark/edit.
    const members = await this.teamMemberModel
      .find({
        'permissionPathOverrides.path': {
          $in: StripAttendanceMarkEditSelfScopeService.RETIRED_PATHS,
        },
      })
      .exec();
    for (const member of members) {
      result.membersScanned++;
      try {
        const overrides = Array.isArray(member.permissionPathOverrides)
          ? member.permissionPathOverrides
          : [];
        const next = overrides.filter(
          (o) =>
            !(
              StripAttendanceMarkEditSelfScopeService.RETIRED_PATHS.includes(o.path) &&
              o.allowed === true &&
              (o.scope ?? 'self') === 'self'
            ),
        );
        if (next.length === overrides.length) continue;

        await this.teamMemberModel.updateOne(
          { _id: member._id },
          { $set: { permissionPathOverrides: next } },
        );
        result.membersUpdated++;
      } catch (err) {
        const message = `member ${String(member._id)}: ${(err as Error)?.message ?? err}`;
        result.errors.push(message);
        this.logger.warn(`strip mark/edit self-scope (member) error — ${message}`);
      }
    }

    return result;
  }
}
