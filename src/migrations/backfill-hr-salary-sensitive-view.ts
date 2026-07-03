import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import type { PermissionScope } from '../modules/rbac/schemas/role.schema';
import { AppModule, ModuleAction } from '../common/enums/modules.enum';
import { DEFAULT_HR_ROLE } from '../modules/rbac/role-seeder.constants';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

/**
 * Salary slice A3 Task 3 (2026-05-30) — backfill `salary.sensitive_view` onto
 * the seeded system HR role for every existing workspace.
 *
 * The salary read-filter gates sensitive fields (bank account, PAN, Aadhaar)
 * behind this action. New workspaces get the action inline via the updated
 * `DEFAULT_HR_ROLE` preset in `RoleSeederService`; this migration backfills
 * existing workspace HR roles created before A3 shipped.
 *
 * Additive + idempotent + minimally invasive:
 *   - Targets only `{ isSystem: true, name: 'HR' }` rows — the seeded preset.
 *     Custom roles or a renamed HR role are not touched.
 *   - Appends `sensitive_view` (`all` scope, parallel with the existing salary
 *     grant) only when the action is absent. If already present (any scope),
 *     the role is skipped.
 *   - If the owner stripped the `salary` grant entirely, the role is skipped
 *     rather than recreated — that is a deliberate customization.
 *
 * Re-running is a no-op. Mirrors the `BackfillWorkerRegularizationGrantService`
 * read-modify-write pattern. Runs after existing salary/worker backfills on
 * bootstrap.
 */
@Injectable()
export class BackfillHrSalarySensitiveViewService {
  private readonly logger = new Logger(BackfillHrSalarySensitiveViewService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { rolesScanned: 0, rolesUpdated: 0, errors: [] };

    const roles = await this.roleModel.find({ isSystem: true, name: DEFAULT_HR_ROLE.name }).exec();

    for (const role of roles) {
      result.rolesScanned++;
      try {
        const salaryGrant = role.permissions.find((p) => p.module === AppModule.SALARY);
        // Owner stripped the salary grant entirely — deliberate customization.
        if (!salaryGrant) continue;
        // Already granted (any scope) — idempotent + owner-intent-safe.
        if (salaryGrant.actions.includes(ModuleAction.SENSITIVE_VIEW)) continue;

        const nextPermissions = role.permissions.map((perm) => {
          if (perm.module !== AppModule.SALARY) {
            return {
              module: perm.module,
              actions: perm.actions,
              actionScopes: perm.actionScopes,
            };
          }
          // Keep the parallel actions[] / actionScopes[] arrays in lockstep:
          // pad any short scope array to match existing actions, then append
          // the new sensitive_view grant at `all` scope (HR is all-scoped).
          const existing: PermissionScope[] = Array.isArray(perm.actionScopes)
            ? perm.actionScopes
            : [];
          const filled: PermissionScope[] = [];
          for (let i = 0; i < perm.actions.length; i++) {
            filled.push(existing[i] ?? 'all');
          }
          return {
            module: perm.module,
            actions: [...perm.actions, ModuleAction.SENSITIVE_VIEW],
            actionScopes: [...filled, 'all'],
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
        this.logger.warn(`HR salary sensitive-view backfill error -- ${message}`);
      }
    }

    return result;
  }
}
