import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import { flatGrantsToPaths } from '../modules/rbac/permission-path.converter';
import { DEFAULT_ROLES } from '../modules/rbac/role-seeder.constants';
import type { GrantedPermission } from '../modules/rbac/permission-matcher';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

/**
 * RBAC re-architecture Phase 1a — backfill `Role.permissionPaths` for every
 * existing role so the fail-closed `@RequirePermission` matcher has grants to
 * match against once `RolesGuard` goes global.
 *
 * Source picked per role:
 *   - System roles (Member / Worker / Manager / HR, matched by name) →
 *     `DEFAULT_ROLES[].permissionPaths` — the exact hand-authored grants, not
 *     the converter's least-privilege approximation. The role seeder writes
 *     these inline on workspace.create; this backfill covers every workspace
 *     created BEFORE Phase 1a (the seeder is insert-only — it never touches
 *     an existing role).
 *   - Custom roles, and any system role whose name no longer matches a preset
 *     (e.g. owner-renamed) → `flatGrantsToPaths(role.permissions)`, a least-
 *     privilege legacy→path conversion. The owner re-tunes via the matrix.
 *
 * Populate-once — a role that already has a non-empty `permissionPaths` is
 * skipped, so owner matrix edits (and the seeder's inline grants on new
 * workspaces) are never clobbered by a re-run. Idempotent + cheap; safe to
 * run on every boot.
 */
@Injectable()
export class BackfillRolePermissionPathsService {
  private readonly logger = new Logger(BackfillRolePermissionPathsService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { rolesScanned: 0, rolesUpdated: 0, errors: [] };
    const roles = await this.roleModel.find({}).exec();

    for (const role of roles) {
      result.rolesScanned++;
      try {
        if (Array.isArray(role.permissionPaths) && role.permissionPaths.length > 0) {
          continue; // already populated — owner-managed / seeded, never clobber
        }
        // A system role matched by name gets the exact preset grants;
        // everything else (custom roles, renamed system roles) falls back to
        // the least-privilege legacy→path conversion.
        const preset = role.isSystem ? DEFAULT_ROLES.find((d) => d.name === role.name) : undefined;
        const paths: GrantedPermission[] = preset
          ? preset.permissionPaths
          : flatGrantsToPaths(role.permissions ?? []);
        if (paths.length === 0) continue;
        await this.roleModel.updateOne({ _id: role._id }, { $set: { permissionPaths: paths } });
        result.rolesUpdated++;
      } catch (err) {
        const message = `role ${String(role._id)} (${role.name}): ${
          (err as Error)?.message ?? err
        }`;
        result.errors.push(message);
        this.logger.warn(`permissionPaths backfill error — ${message}`);
      }
    }
    return result;
  }
}
