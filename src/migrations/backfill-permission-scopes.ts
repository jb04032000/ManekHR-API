import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import type { PermissionScope } from '../modules/rbac/schemas/role.schema';
import { DEFAULT_MEMBER_ROLE } from '../modules/rbac/role-seeder.constants';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

/**
 * Access Control Initiative (2026-05-15) — backfill explicit `actionScopes`
 * on every existing Role.
 *
 * Before this migration, a permission grant with no `actionScopes` entry
 * was treated as `'all'` (org-wide) by RolesGuard. The seeded Member role
 * shipped with no scopes, so an invited employee was effectively org-wide
 * and could view the whole workspace's attendance.
 *
 * This migration writes an explicit scope on every grant so nothing relies
 * on a fallback:
 *   - The system **Member** role → `'self'` on every action — the least-
 *     privilege baseline (an employee sees only their own data).
 *   - Every other role (custom roles authored before scope-awareness, with
 *     genuine org-wide intent) → missing scopes written as `'all'` to
 *     preserve their current behaviour. The owner re-tunes them via the
 *     role editor.
 *
 * `TeamMember.permissionOverrides` are intentionally NOT touched: an
 * override with no `scope` must not change the role's scope (see
 * `applyPermissionOverrides`), and leaving it undefined preserves that.
 *
 * Idempotent — only fills missing/short `actionScopes`; re-running is a
 * no-op. Must run AFTER the default-Member-role backfill so freshly
 * created Member roles are scoped too.
 */
@Injectable()
export class BackfillPermissionScopesService {
  private readonly logger = new Logger(BackfillPermissionScopesService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { rolesScanned: 0, rolesUpdated: 0, errors: [] };

    const roles = await this.roleModel.find({}).exec();

    for (const role of roles) {
      result.rolesScanned++;
      try {
        const isMemberRole = role.isSystem && role.name === DEFAULT_MEMBER_ROLE.name;
        const fillScope: PermissionScope = isMemberRole ? 'self' : 'all';

        let changed = false;
        const nextPermissions = role.permissions.map((perm) => {
          const existing = Array.isArray(perm.actionScopes) ? perm.actionScopes : [];
          if (existing.length === perm.actions.length) {
            return {
              module: perm.module,
              actions: perm.actions,
              actionScopes: existing,
            };
          }
          changed = true;
          const filledScopes: PermissionScope[] = [];
          for (let i = 0; i < perm.actions.length; i++) {
            filledScopes.push(existing[i] ?? fillScope);
          }
          return {
            module: perm.module,
            actions: perm.actions,
            actionScopes: filledScopes,
          };
        });

        if (changed) {
          await this.roleModel.updateOne(
            { _id: role._id },
            { $set: { permissions: nextPermissions } },
          );
          result.rolesUpdated++;
        }
      } catch (err) {
        const message = `role ${String(role._id)} (${role.name}): ${
          (err as Error)?.message ?? err
        }`;
        result.errors.push(message);
        this.logger.warn(`Scope backfill error — ${message}`);
      }
    }

    return result;
  }
}
