import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import { resolveImplicitDeps } from '../modules/rbac/dep-resolver';
import type { GrantedPermission } from '../modules/rbac/permission-matcher';
import type { PermissionScope } from '../modules/rbac/permission-registry';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

const SCOPE_RANK: Record<PermissionScope, number> = { self: 0, all: 1 };

function isLeavePath(path: string): boolean {
  return path.split('.')[0] === 'leave';
}

/**
 * Leave self-service grant-completeness backfill (2026-05-25).
 *
 * The leave registry now declares cross-leaf `requires` edges so a self-leave
 * grant pulls its full read bundle:
 *   - `leave.request.view`  requires `leave.balance.view@self`
 *   - `leave.compOff.apply` requires `leave.request.view@self` + `leave.balance.view@self`
 *
 * Without those reads the My Leave / My Comp-off pages cannot load their
 * balances (separate leaf) and a partial grant blanked the page. New grants
 * get the bundle automatically (the matrix runs `resolveImplicitDeps`; new
 * roles are seeded already-complete). This migration tops up EXISTING roles
 * whose stored `permissionPaths` predate the edges — chiefly custom / legacy-
 * converted roles (the `apply_leave` legacy action converts to
 * `compOff.apply` WITHOUT the read leaves).
 *
 * Bounded to the leave module: it runs `resolveImplicitDeps` over each role's
 * grants but only merges back the `leave.*` additions / scope upgrades, so it
 * never touches team / attendance / regularization grants (whose own `requires`
 * edges, e.g. `team.member.create`, are out of scope here).
 *
 * Merge semantics — UNION, never clobber:
 *   - Only missing leave leaves are added (at the resolver's `@self` scope);
 *     an already-present leaf keeps the WIDER scope (`all` beats `self`).
 *   - Empty `permissionPaths` roles are skipped — they are owned by the
 *     populate-once backfill, which seeds the full (already-complete) set.
 *
 * Idempotent — a re-run finds every leave dep already present and writes
 * nothing. Cheap; safe to run on every boot.
 */
@Injectable()
export class BackfillLeaveSelfServiceGrantDepsService {
  private readonly logger = new Logger(BackfillLeaveSelfServiceGrantDepsService.name);

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
        // Empty → owned by the populate-once backfill (full, already-complete
        // set). Skip so we never write a half-populated role here.
        if (existing.length === 0) continue;

        // Resolve every declared dependency, then keep only the leave-module
        // additions / upgrades — team/attendance/regularization deps stay out.
        const resolved = resolveImplicitDeps(existing);
        const have = new Map<string, PermissionScope>(existing.map((g) => [g.path, g.scope]));
        let changed = false;
        for (const g of resolved) {
          if (!isLeavePath(g.path)) continue;
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
        this.logger.warn(`leave self-service grant-deps backfill error — ${message}`);
      }
    }
    return result;
  }
}
