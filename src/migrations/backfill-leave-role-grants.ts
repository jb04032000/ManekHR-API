import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../modules/rbac/schemas/role.schema';
import { AppModule } from '../common/enums/modules.enum';
import { DEFAULT_ROLES } from '../modules/rbac/role-seeder.constants';

interface MigrationResult {
  rolesScanned: number;
  rolesUpdated: number;
  errors: string[];
}

/**
 * Leave epic L3a (2026-05-16) — grant the `leave` module to the seeded system
 * roles (Member / Worker / Manager / HR) on existing workspaces.
 *
 * New workspaces get the leave grants inline via the updated role-seeder
 * preset; this migration backfills workspaces created before L3a shipped.
 *
 * Additive + idempotent: for each system role matching a `DEFAULT_ROLES`
 * entry by name, appends that role's canonical `leave` permission if absent.
 * A role that already carries a `leave` grant (any scope) is left untouched —
 * owner intent is never overwritten. Runs unconditionally on bootstrap.
 */
@Injectable()
export class BackfillLeaveRoleGrantsService {
  private readonly logger = new Logger(BackfillLeaveRoleGrantsService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      rolesScanned: 0,
      rolesUpdated: 0,
      errors: [],
    };

    for (const def of DEFAULT_ROLES) {
      const leaveGrant = def.permissions.find((p) => p.module === AppModule.LEAVE);
      // Role preset has no leave grant — nothing to backfill for this role.
      if (!leaveGrant) continue;

      const roles = await this.roleModel.find({ isSystem: true, name: def.name }).exec();

      for (const role of roles) {
        result.rolesScanned++;
        try {
          // Already granted (any scope) — idempotent + owner-intent-safe.
          if (role.permissions.some((p) => p.module === AppModule.LEAVE)) {
            continue;
          }
          const nextPermissions = [
            ...role.permissions.map((p) => ({
              module: p.module,
              actions: p.actions,
              actionScopes: p.actionScopes,
            })),
            {
              module: leaveGrant.module,
              actions: leaveGrant.actions,
              actionScopes: leaveGrant.actionScopes,
            },
          ];
          await this.roleModel.updateOne(
            { _id: role._id },
            { $set: { permissions: nextPermissions } },
          );
          result.rolesUpdated++;
        } catch (err) {
          const message = `role ${String(role._id)} (${role.name}): ${
            err instanceof Error ? err.message : String(err)
          }`;
          result.errors.push(message);
          this.logger.warn(`Leave-role-grant backfill error — ${message}`);
        }
      }
    }

    return result;
  }
}
