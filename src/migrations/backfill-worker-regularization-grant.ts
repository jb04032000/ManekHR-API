import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import type { PermissionScope } from '../modules/rbac/schemas/role.schema';
import { AppModule, ModuleAction } from '../common/enums/modules.enum';
import { DEFAULT_WORKER_ROLE } from '../modules/rbac/role-seeder.constants';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

/**
 * Access Control Initiative §8 Part B2 (2026-05-16) — grant the seeded
 * Worker role self-service regularization.
 *
 * Part B2 lets a self-scoped Worker raise their own attendance-correction
 * requests. New workspaces get the updated preset inline via
 * `RoleSeederService`; this migration backfills the system Worker role for
 * workspaces created before B2 shipped.
 *
 * Additive + idempotent + minimally invasive:
 *   - Targets only `{ isSystem: true, name: 'Worker' }` rows — the seeded
 *     preset. A custom role or a Worker the owner renamed is left alone.
 *   - Appends `manage_regularizations` (`self` scope) to the role's
 *     existing `attendance` grant. If the owner already added it (any
 *     scope), the role is skipped — owner intent is never overwritten.
 *   - If the owner stripped the `attendance` grant entirely, the role is
 *     skipped rather than recreated — that is a deliberate customization.
 *
 * Re-running is a no-op. Mirrors the `BackfillPermissionScopesService`
 * read-modify-write pattern; runs after it on bootstrap.
 */
@Injectable()
export class BackfillWorkerRegularizationGrantService {
  private readonly logger = new Logger(BackfillWorkerRegularizationGrantService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { rolesScanned: 0, rolesUpdated: 0, errors: [] };

    const roles = await this.roleModel
      .find({ isSystem: true, name: DEFAULT_WORKER_ROLE.name })
      .exec();

    for (const role of roles) {
      result.rolesScanned++;
      try {
        const attendance = role.permissions.find((p) => p.module === AppModule.ATTENDANCE);
        // Owner stripped the attendance grant — a deliberate customization.
        if (!attendance) continue;
        // Already granted (any scope) — idempotent + owner-intent-safe.
        if (attendance.actions.includes(ModuleAction.MANAGE_REGULARIZATIONS)) continue;

        const nextPermissions = role.permissions.map((perm) => {
          if (perm.module !== AppModule.ATTENDANCE) {
            return {
              module: perm.module,
              actions: perm.actions,
              actionScopes: perm.actionScopes,
            };
          }
          // Keep the parallel actions[] / actionScopes[] arrays in lockstep:
          // pad any short scope array, then append the new self-scoped grant.
          const existing = Array.isArray(perm.actionScopes) ? perm.actionScopes : [];
          const filled: PermissionScope[] = [];
          for (let i = 0; i < perm.actions.length; i++) {
            filled.push(existing[i] ?? 'self');
          }
          return {
            module: perm.module,
            actions: [...perm.actions, ModuleAction.MANAGE_REGULARIZATIONS],
            actionScopes: [...filled, 'self'],
          };
        });

        await this.roleModel.updateOne(
          { _id: role._id },
          { $set: { permissions: nextPermissions } },
        );
        result.rolesUpdated++;
      } catch (err) {
        const message = `role ${String(role._id)} (${role.name}): ${
          (err as Error)?.message ?? err
        }`;
        result.errors.push(message);
        this.logger.warn(`Worker-regularization backfill error — ${message}`);
      }
    }

    return result;
  }
}
