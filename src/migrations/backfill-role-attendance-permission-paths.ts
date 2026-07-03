import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import { flatGrantsToPaths } from '../modules/rbac/permission-path.converter';
import { DEFAULT_ROLES } from '../modules/rbac/role-seeder.constants';
import type { GrantedPermission } from '../modules/rbac/permission-matcher';
import type { PermissionScope } from '../modules/rbac/permission-registry';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

/** Registry modules introduced by the Attendance rollout (Phase A). */
const NEW_MODULES: readonly string[] = ['attendance', 'leave', 'regularization'];
const SCOPE_RANK: Record<PermissionScope, number> = { self: 0, all: 1 };

function isNewModulePath(path: string): boolean {
  return NEW_MODULES.includes(path.split('.')[0]);
}

/**
 * Attendance rollout Phase A — MERGE the attendance / leave / regularization
 * registry paths onto every EXISTING role's `permissionPaths`.
 *
 * Why a second backfill (not the Phase 1a `backfill-role-permission-paths`):
 * that one is **populate-once** — it skips any role that already has a
 * non-empty `permissionPaths`. Existing workspaces ran it when only `team`
 * was path-classified, so their roles carry team-only paths. The moment a
 * route is migrated to `@RequirePermission('attendance.…')` (rollout Phase B),
 * those roles would have NO attendance path and members would lose access.
 * This migration closes that gap and MUST run before Phase B deploys.
 *
 * Source per role (mirrors the Phase 1a backfill):
 *   - System role matched by name → the exact hand-authored
 *     `DEFAULT_ROLES[].permissionPaths` (filtered to the new modules).
 *   - Custom / renamed role → `flatGrantsToPaths(role.permissions)` (filtered
 *     to the new modules) — the least-privilege legacy→path conversion.
 *
 * Merge semantics — UNION, never clobber:
 *   - Only the new-module paths are added; existing `team` paths (and any
 *     owner matrix edits to them) are left exactly as they are.
 *   - A path already present keeps the WIDER scope (`all` beats `self`).
 *   - Roles with an EMPTY `permissionPaths` are skipped — they are owned by
 *     the populate-once backfill, which now emits attendance paths too (the
 *     converter maps them). Skipping avoids ever writing a role that has
 *     attendance paths but no team paths.
 *
 * Idempotent — a re-run finds every new path already present at sufficient
 * scope and writes nothing. Cheap; safe to run on every boot.
 */
@Injectable()
export class BackfillRoleAttendancePermissionPathsService {
  private readonly logger = new Logger(BackfillRoleAttendancePermissionPathsService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { rolesScanned: 0, rolesUpdated: 0, errors: [] };
    const roles = await this.roleModel.find({}).exec();

    for (const role of roles) {
      result.rolesScanned++;
      try {
        const existing: GrantedPermission[] = Array.isArray(role.permissionPaths)
          ? role.permissionPaths
          : [];
        // Empty → owned by the populate-once backfill (full set incl. the new
        // modules). Skip so we never strand attendance paths without team.
        if (existing.length === 0) continue;

        const preset = role.isSystem ? DEFAULT_ROLES.find((d) => d.name === role.name) : undefined;
        const source: GrantedPermission[] = preset
          ? preset.permissionPaths
          : flatGrantsToPaths(role.permissions ?? []);
        const additions = source.filter((g) => isNewModulePath(g.path));
        if (additions.length === 0) continue;

        const have = new Map<string, PermissionScope>(existing.map((g) => [g.path, g.scope]));
        let changed = false;
        for (const g of additions) {
          const cur = have.get(g.path);
          if (cur === undefined) {
            have.set(g.path, g.scope);
            changed = true;
          } else if (SCOPE_RANK[cur] < SCOPE_RANK[g.scope]) {
            have.set(g.path, g.scope);
            changed = true;
          }
        }
        if (!changed) continue;

        const merged: GrantedPermission[] = [...have.entries()].map(([path, scope]) => ({
          path,
          scope,
        }));
        await this.roleModel.updateOne({ _id: role._id }, { $set: { permissionPaths: merged } });
        result.rolesUpdated++;
      } catch (err) {
        const message = `role ${String(role._id)} (${role.name}): ${
          (err as Error)?.message ?? err
        }`;
        result.errors.push(message);
        this.logger.warn(`attendance permissionPaths backfill error — ${message}`);
      }
    }
    return result;
  }
}
