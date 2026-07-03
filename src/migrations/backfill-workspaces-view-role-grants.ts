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
 * RBAC Remediation Tier 1 (2026-05-18) — backfill `workspaces.VIEW` (`scope:
 * 'all'`) onto existing Manager and HR system roles.
 *
 * Background: After workspaces controller endpoints were gated with
 * `@RequirePermissions(AppModule.WORKSPACES, ModuleAction.VIEW)`, existing
 * Manager/HR role documents lack this grant and would start 403-ing on every
 * workspace-settings page load.  New workspaces are handled inline by the
 * updated `role-seeder.constants.ts`; this migration covers workspaces
 * created before this fix shipped.
 *
 * Additive + idempotent: appends the `WORKSPACES.VIEW all` grant only when
 * no `workspaces` grant already exists on the role. A role that was manually
 * given a `workspaces.*` grant (any scope) is left untouched — owner intent
 * is never overwritten. Runs unconditionally on every bootstrap.
 *
 * Only Manager and HR roles receive the grant (least-privilege: Member /
 * Worker remain unable to reach workspace settings surfaces).
 */
@Injectable()
export class BackfillWorkspacesViewRoleGrantsService {
  private readonly logger = new Logger(BackfillWorkspacesViewRoleGrantsService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      rolesScanned: 0,
      rolesUpdated: 0,
      errors: [],
    };

    // NOTE (RBAC Remediation Tier 1): system roles are matched by canonical
    // name. A workspace owner who renamed their 'Manager'/'HR' system role will
    // not be backfilled here — that role's members would then 403 on workspace
    // endpoints until the owner re-grants WORKSPACES.VIEW (fail-closed, no data
    // leak). A structural role-type discriminator is a Tier-2 follow-up.
    const targetRoleNames = ['Manager', 'HR'];

    for (const roleName of targetRoleNames) {
      const roles = await this.roleModel.find({ isSystem: true, name: roleName }).exec();

      for (const role of roles) {
        result.rolesScanned++;
        try {
          // Already carries any workspaces grant — idempotent + owner-intent-safe.
          if (role.permissions.some((p) => p.module === AppModule.WORKSPACES)) {
            continue;
          }

          const nextPermissions = [
            ...role.permissions.map((p) => ({
              module: p.module,
              actions: p.actions,
              actionScopes: p.actionScopes,
            })),
            {
              module: AppModule.WORKSPACES,
              actions: [ModuleAction.VIEW],
              actionScopes: ['all' as const],
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
          this.logger.warn(`workspaces-view grant backfill error — ${message}`);
        }
      }
    }

    return result;
  }
}
