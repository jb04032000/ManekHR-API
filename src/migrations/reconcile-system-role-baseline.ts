import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import { DEFAULT_ROLES } from '../modules/rbac/role-seeder.constants';
import type { GrantedPermission } from '../modules/rbac/permission-matcher';
import type { PermissionScope } from '../modules/rbac/permission-registry';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

const SCOPE_RANK: Record<PermissionScope, number> = { self: 0, all: 1 };

/**
 * System-role baseline reconcile (2026-07-03, owner directive) — ensure every
 * seeded system role (Partner / Manager / Accountant / Employee) carries AT
 * LEAST the current hand-authored defaults from `DEFAULT_ROLES`, on every
 * workspace. Fixes roles seeded before newer permissions existed (e.g. an
 * Employee role predating the attendance/leave registry paths shows as
 * near-empty in the permission grid).
 *
 * Merge semantics — UNION, never remove (mirrors migration 0021):
 *   - Flat `permissions`: a default (module, action) missing on the role is
 *     added; a present one keeps the WIDER scope (`all` beats `self`).
 *   - `permissionPaths`: same union + widen-scope rule per path.
 *   - Owner additions on top of the defaults are always preserved. An owner
 *     REMOVAL of a default grant gets re-added — accepted trade-off: these are
 *     the baseline every holder of the role should have; per-member deny
 *     overrides remain the tool for narrowing.
 *   - Roles matched by `isSystem: true` + exact default name. Renamed or
 *     legacy-named system roles (pre-redesign Member/Worker/HR) are untouched.
 *
 * Convergent + idempotent: a re-run finds every default grant present at
 * sufficient scope and writes nothing. Bump the checksum in
 * migrations.module.ts whenever `role-seeder.constants.ts` defaults change so
 * the runner re-applies them to existing workspaces.
 */
@Injectable()
export class ReconcileSystemRoleBaselineService {
  private readonly logger = new Logger(ReconcileSystemRoleBaselineService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { rolesScanned: 0, rolesUpdated: 0, errors: [] };

    const defaultNames = DEFAULT_ROLES.map((d) => d.name);
    const roles = await this.roleModel.find({ isSystem: true, name: { $in: defaultNames } }).exec();

    for (const role of roles) {
      result.rolesScanned++;
      try {
        const def = DEFAULT_ROLES.find((d) => d.name === role.name);
        if (!def) continue;

        const update: Record<string, unknown> = {};

        // ── Flat permissions: union per (module, action), widen scope ──
        // Role rows keep `actions[i]` parallel to `actionScopes[i]`.
        const flat = new Map<string, Map<string, PermissionScope>>();
        for (const row of role.permissions ?? []) {
          const actions = flat.get(row.module) ?? new Map<string, PermissionScope>();
          row.actions.forEach((a, i) => {
            actions.set(a, (row.actionScopes?.[i] as PermissionScope) ?? 'self');
          });
          flat.set(row.module, actions);
        }
        let flatChanged = false;
        for (const row of def.permissions) {
          const actions = flat.get(row.module) ?? new Map<string, PermissionScope>();
          row.actions.forEach((a, i) => {
            const want = (row.actionScopes?.[i] as PermissionScope) ?? 'self';
            const cur = actions.get(a);
            if (cur === undefined || SCOPE_RANK[cur] < SCOPE_RANK[want]) {
              actions.set(a, cur === undefined ? want : 'all');
              flatChanged = true;
            }
          });
          flat.set(row.module, actions);
        }
        if (flatChanged) {
          update.permissions = [...flat.entries()].map(([module, actions]) => ({
            module,
            actions: [...actions.keys()],
            actionScopes: [...actions.values()],
          }));
        }

        // ── permissionPaths: union per path, widen scope (mirrors 0021) ──
        const have = new Map<string, PermissionScope>(
          (role.permissionPaths ?? []).map((g) => [g.path, g.scope]),
        );
        let pathsChanged = false;
        for (const g of def.permissionPaths) {
          const cur = have.get(g.path);
          if (cur === undefined || SCOPE_RANK[cur] < SCOPE_RANK[g.scope]) {
            have.set(g.path, g.scope);
            pathsChanged = true;
          }
        }
        if (pathsChanged) {
          const merged: GrantedPermission[] = [...have.entries()].map(([path, scope]) => ({
            path,
            scope,
          }));
          update.permissionPaths = merged;
        }

        if (!flatChanged && !pathsChanged) continue;

        await this.roleModel.updateOne({ _id: role._id }, { $set: update });
        result.rolesUpdated++;
      } catch (err) {
        const message = `role ${String(role._id)} (${role.name}): ${
          (err as Error)?.message ?? err
        }`;
        result.errors.push(message);
        this.logger.warn(`system-role baseline reconcile error — ${message}`);
      }
    }

    this.logger.log(
      `system-role baseline reconcile: scanned=${result.rolesScanned} updated=${result.rolesUpdated} errors=${result.errors.length}`,
    );
    return result;
  }
}
