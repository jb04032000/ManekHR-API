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
 * Advance self-service (2026-06-14) — backfill `salary.request_advance` (self)
 * onto the seeded system Worker/Karigar role for every existing workspace.
 *
 * New workspaces get the action inline via the updated `DEFAULT_WORKER_ROLE`
 * preset; this backfills existing Worker roles created before the feature
 * shipped so their members can raise an advance request. Inert until the
 * workspace also has the `advance_payments` subscription sub-feature AND its
 * advanceRequestPolicy window is open, so this never changes free-tier behaviour.
 *
 * Additive + idempotent + minimally invasive (mirrors BackfillHrSalarySensitiveView):
 *   - Targets only `{ isSystem: true, name: 'Worker' }` rows — the seeded preset.
 *   - Worker has NO salary grant today, so this ADDS a fresh
 *     `salary [request_advance] @self` grant. If a salary grant already exists
 *     (e.g. owner-customized) it appends request_advance only when absent.
 *   - Already-present (any scope) → skipped.
 *
 * Re-running is a no-op. Links: role-seeder.constants.ts DEFAULT_WORKER_ROLE,
 * advance-salary-request.controller.ts (REQUEST_ADVANCE self gate).
 */
@Injectable()
export class BackfillWorkerRequestAdvanceGrantService {
  private readonly logger = new Logger(BackfillWorkerRequestAdvanceGrantService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { rolesScanned: 0, rolesUpdated: 0, errors: [] };

    const roles = await this.roleModel
      .find({ isSystem: true, name: DEFAULT_WORKER_ROLE.name })
      .exec();

    for (const role of roles) {
      result.rolesScanned++;
      try {
        const salaryGrant = role.permissions.find((p) => p.module === AppModule.SALARY);

        // Already granted (any scope) — idempotent + owner-intent-safe.
        if (salaryGrant?.actions.includes(ModuleAction.REQUEST_ADVANCE)) continue;

        let nextPermissions;
        if (!salaryGrant) {
          // Worker has no salary grant by default — add a fresh self-scoped one.
          nextPermissions = [
            ...role.permissions.map((perm) => ({
              module: perm.module,
              actions: perm.actions,
              actionScopes: perm.actionScopes,
            })),
            {
              module: AppModule.SALARY,
              actions: [ModuleAction.REQUEST_ADVANCE],
              actionScopes: ['self' as PermissionScope],
            },
          ];
        } else {
          // A salary grant exists (custom) — append request_advance @self, keeping
          // the parallel actions[]/actionScopes[] arrays in lockstep.
          nextPermissions = role.permissions.map((perm) => {
            if (perm.module !== AppModule.SALARY) {
              return {
                module: perm.module,
                actions: perm.actions,
                actionScopes: perm.actionScopes,
              };
            }
            const existing: PermissionScope[] = Array.isArray(perm.actionScopes)
              ? perm.actionScopes
              : [];
            const filled: PermissionScope[] = [];
            for (let i = 0; i < perm.actions.length; i++) {
              filled.push(existing[i] ?? 'self');
            }
            return {
              module: perm.module,
              actions: [...perm.actions, ModuleAction.REQUEST_ADVANCE],
              actionScopes: [...filled, 'self' as PermissionScope],
            };
          });
        }

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
        this.logger.warn(`worker request-advance grant backfill error -- ${message}`);
      }
    }

    return result;
  }
}
