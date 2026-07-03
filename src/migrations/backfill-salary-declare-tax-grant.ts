import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import type { PermissionScope } from '../modules/rbac/schemas/role.schema';
import { AppModule, ModuleAction } from '../common/enums/modules.enum';
import { DEFAULT_WORKER_ROLE, DEFAULT_HR_ROLE } from '../modules/rbac/role-seeder.constants';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

/**
 * Salary hardening security-review fix HIGH-1 (OQ-S6) — backfill the dedicated
 * `salary.declare_tax` self-service action onto the seeded system roles for every
 * existing workspace:
 *   - Worker / Karigar → `declare_tax @self` (file their OWN tax declaration).
 *   - HR               → `declare_tax @all`  (keep HR's existing all-scoped
 *                        upsert path — the route now gates on declare_tax, not
 *                        salary.edit, so HR needs the explicit grant).
 * The workspace owner bypasses RolesGuard, so no owner backfill is needed.
 *
 * New workspaces get the actions inline via the updated role presets
 * (`DEFAULT_WORKER_ROLE` / `DEFAULT_HR_ROLE`); this backfills roles created before
 * the fix shipped. Inert until the workspace also has the `statutory_tds`
 * subscription sub-feature, so this never changes free-tier behaviour.
 *
 * Additive + idempotent + minimally invasive (mirrors
 * BackfillWorkerRequestAdvanceGrantService exactly):
 *   - Targets only the seeded `{ isSystem: true }` Worker + HR presets.
 *   - If the role has no salary grant, ADD a fresh `salary [declare_tax] @scope`.
 *   - If a salary grant exists, append declare_tax @scope only when absent,
 *     keeping the parallel actions[]/actionScopes[] arrays in lockstep.
 *   - Already-present (any scope) → skipped. Re-running is a no-op.
 *
 * Links: role-seeder.constants.ts (DEFAULT_WORKER_ROLE / DEFAULT_HR_ROLE),
 * salary.controller.ts upsertTaxDeclaration (DECLARE_TAX self gate),
 * backfill-worker-request-advance-grant.ts (the pattern this mirrors).
 */
@Injectable()
export class BackfillSalaryDeclareTaxGrantService {
  private readonly logger = new Logger(BackfillSalaryDeclareTaxGrantService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { rolesScanned: 0, rolesUpdated: 0, errors: [] };

    // Worker gets self scope; HR gets all scope. Owner needs nothing (bypass).
    const targets: { name: string; scope: PermissionScope }[] = [
      { name: DEFAULT_WORKER_ROLE.name, scope: 'self' },
      { name: DEFAULT_HR_ROLE.name, scope: 'all' },
    ];

    for (const target of targets) {
      const roles = await this.roleModel.find({ isSystem: true, name: target.name }).exec();

      for (const role of roles) {
        result.rolesScanned++;
        try {
          const salaryGrant = role.permissions.find((p) => p.module === AppModule.SALARY);

          // Already granted (any scope) — idempotent + owner-intent-safe.
          if (salaryGrant?.actions.includes(ModuleAction.DECLARE_TAX)) continue;

          let nextPermissions;
          if (!salaryGrant) {
            // No salary grant on this role — add a fresh scoped one.
            nextPermissions = [
              ...role.permissions.map((perm) => ({
                module: perm.module,
                actions: perm.actions,
                actionScopes: perm.actionScopes,
              })),
              {
                module: AppModule.SALARY,
                actions: [ModuleAction.DECLARE_TAX],
                actionScopes: [target.scope],
              },
            ];
          } else {
            // A salary grant exists — append declare_tax @scope, keeping the
            // parallel actions[]/actionScopes[] arrays in lockstep.
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
                // Default unknown legacy scopes to the role's intended scope, not
                // a blanket 'self' — preserves an all-scoped HR salary grant.
                filled.push(existing[i] ?? target.scope);
              }
              return {
                module: perm.module,
                actions: [...perm.actions, ModuleAction.DECLARE_TAX],
                actionScopes: [...filled, target.scope],
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
          this.logger.warn(`salary declare-tax grant backfill error -- ${message}`);
        }
      }
    }

    return result;
  }
}
