import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import { AppModule, ModuleAction } from '../common/enums/modules.enum';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

/**
 * Strip `salary.declare_tax` from the Employee/Accountant baseline
 * (2026-07-03, owner directive) — the v2 baseline reconcile (migration 0055)
 * briefly granted declare_tax to the Employee baseline (Accountant inherits
 * Employee's block via spread); the owner ruled tax declaration an ADVANCED
 * statutory feature that must be granted per role explicitly, not a default.
 * DEFAULT_EMPLOYEE_ROLE no longer carries it; this removes the already-written
 * grant from existing Employee/Accountant system roles.
 *
 * Deliberately narrow: only `isSystem` roles named Employee/Accountant, only
 * the `declare_tax` action inside the `salary` row (`actions[i]` and its
 * parallel `actionScopes[i]` are removed together). Other roles keep their
 * declare_tax (Manager/Partner defaults + the 0041 Worker/HR backfill are
 * intentional). One-shot, idempotent (re-run finds no action => 0 writes).
 */
@Injectable()
export class StripEmployeeDeclareTaxGrantService {
  private readonly logger = new Logger(StripEmployeeDeclareTaxGrantService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { rolesScanned: 0, rolesUpdated: 0, errors: [] };

    const roles = await this.roleModel
      .find({ isSystem: true, name: { $in: ['Employee', 'Accountant'] } })
      .exec();

    for (const role of roles) {
      result.rolesScanned++;
      try {
        let changed = false;
        const permissions = (role.permissions ?? []).map((row) => {
          if (row.module !== AppModule.SALARY || !row.actions.includes(ModuleAction.DECLARE_TAX))
            return row;
          changed = true;
          const keepIdx = row.actions
            .map((a, i) => (a === ModuleAction.DECLARE_TAX ? -1 : i))
            .filter((i) => i >= 0);
          const scopes = row.actionScopes;
          return {
            module: row.module,
            actions: keepIdx.map((i) => row.actions[i]),
            actionScopes: scopes ? keepIdx.map((i) => scopes[i]) : undefined,
          };
        });
        if (!changed) continue;

        await this.roleModel.updateOne({ _id: role._id }, { $set: { permissions } });
        result.rolesUpdated++;
      } catch (err) {
        const message = `role ${String(role._id)} (${role.name}): ${
          (err as Error)?.message ?? err
        }`;
        result.errors.push(message);
        this.logger.warn(`strip declare_tax error — ${message}`);
      }
    }

    this.logger.log(
      `strip employee declare_tax: scanned=${result.rolesScanned} updated=${result.rolesUpdated} errors=${result.errors.length}`,
    );
    return result;
  }
}
