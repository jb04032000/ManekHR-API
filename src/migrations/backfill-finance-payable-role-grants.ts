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

/** The new registry leaves introduced by Finance/Bills hardening (OQ-FB-2). */
const PAYABLE_PREFIX = 'finance.payable.';

function isPayablePath(path: string): boolean {
  return path.startsWith(PAYABLE_PREFIX);
}

/**
 * Finance/Bills hardening (OQ-FB-2, 2026-06-15) — MERGE the new
 * `finance.payable.*` registry paths onto EXISTING system roles
 * (Manager / HR) so their members keep working access to the legacy AP/AR Bills
 * surface after `BillsController` is migrated off the DEPRECATED
 * `AppModule.BILLS` flat permission onto the FINANCE path model.
 *
 * Without this backfill, the moment `BillsController` routes become
 * `@RequirePermission('finance.payable.…')`, EXISTING workspaces' Manager/HR
 * roles (whose `permissionPaths` were seeded before the `payable` feature
 * existed) would have NO payable path and those members would lose Bills
 * access. New workspaces get the grants inline via the updated role-seeder
 * preset; this migration closes the gap for pre-existing ones.
 *
 * Mirrors `BackfillRoleAttendancePermissionPathsService` exactly:
 *   - Source = the EXACT hand-authored `DEFAULT_ROLES[].permissionPaths`
 *     (filtered to `finance.payable.*`) for a system role matched by NAME, so
 *     Manager gets view/create/edit/recordPayment and HR additionally gets the
 *     sensitive `delete`. A custom/renamed role is NOT touched (it never had a
 *     preset and bills was never a worker grant — owner re-tunes via the
 *     matrix; we never silently widen a custom role onto a money surface).
 *   - Roles with an EMPTY `permissionPaths` are skipped — they are owned by the
 *     populate-once `backfill-role-permission-paths`, which already emits the
 *     full preset (incl. the new payable paths) for system roles.
 *   - UNION merge: only the payable paths are added; existing paths (and any
 *     owner matrix edits) are untouched. A path already present keeps the WIDER
 *     scope. The Worker/Member preset has NO finance grant, so a worker role is
 *     never widened — Bills access stays removed for workers (OQ-FB-2).
 *
 * Idempotent — a re-run finds every payable path already present at sufficient
 * scope and writes nothing. Registered as a ledgered `once` unit (ADR-0001).
 *
 * Dependency note: writes only the rbac `roles` collection. No cross-module
 * write. Consumed by RolesGuard (`finance.payable.*` path checks on
 * BillsController).
 */
@Injectable()
export class BackfillFinancePayableRoleGrantsService {
  private readonly logger = new Logger(BackfillFinancePayableRoleGrantsService.name);

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
        // Empty → owned by the populate-once backfill (full preset incl. payable).
        if (existing.length === 0) continue;

        // System role matched by name → its exact hand-authored preset. A
        // custom/renamed role has no preset; we do NOT add a money grant to it.
        const preset = role.isSystem ? DEFAULT_ROLES.find((d) => d.name === role.name) : undefined;
        if (!preset) continue;

        const additions = preset.permissionPaths.filter((g) => isPayablePath(g.path));
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
        this.logger.warn(`finance.payable permissionPaths backfill error — ${message}`);
      }
    }
    return result;
  }
}
