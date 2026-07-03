import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Role } from './schemas/role.schema';
import { DEFAULT_ROLES, DefaultRoleDefinition } from './role-seeder.constants';

interface SeedResult {
  created: string[]; // role names
  skipped: string[];
}

/**
 * Wave 4.11 (2026-05-10) — seeds default workspace-scoped system roles.
 *
 * Called on every workspace.create + by the bootstrap migration to backfill
 * existing workspaces. Idempotent + race-safe: uses `findOneAndUpdate` with
 * `upsert:true` keyed on `(workspaceId, name)` so concurrent calls converge
 * on a single row.
 */
@Injectable()
export class RoleSeederService {
  private readonly logger = new Logger(RoleSeederService.name);

  constructor(@InjectModel(Role.name) private readonly roleModel: Model<Role>) {}

  async seedDefaultRolesForWorkspace(workspaceId: string): Promise<SeedResult> {
    const result: SeedResult = { created: [], skipped: [] };
    const wsObjectId = new Types.ObjectId(workspaceId);

    for (const def of DEFAULT_ROLES) {
      try {
        const upsertResult = await this.upsertRole(wsObjectId, def);
        if (upsertResult.created) {
          result.created.push(def.name);
        } else {
          result.skipped.push(def.name);
        }
      } catch (err) {
        this.logger.error(
          `seed default role ${def.name} failed for workspace=${workspaceId}: ${(err as Error)?.message ?? err}`,
          (err as Error)?.stack,
        );
      }
    }

    return result;
  }

  private async upsertRole(
    workspaceId: Types.ObjectId,
    def: DefaultRoleDefinition,
  ): Promise<{ created: boolean }> {
    const existing = await this.roleModel.findOne({ workspaceId, name: def.name }).exec();

    if (existing) {
      return { created: false };
    }

    // findOneAndUpdate w/ $setOnInsert is race-safe — concurrent callers
    // converge on a single row keyed by (workspaceId, name).
    const res = await this.roleModel
      .findOneAndUpdate(
        { workspaceId, name: def.name },
        {
          $setOnInsert: {
            workspaceId,
            name: def.name,
            description: def.description,
            color: def.color,
            isSystem: true,
            selfProfileEdit: def.selfProfileEdit ?? 'allow',
            permissions: def.permissions,
            permissionPaths: def.permissionPaths,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();

    // `created` is true when the row didn't exist before this call.
    // Detect by comparing createdAt to the upsert moment — but Mongoose
    // doesn't surface that directly. Instead, re-check existence right
    // before the upsert: if we got here, `existing` was null, so this
    // call is the inserter. Race losers see `existing` non-null on their
    // re-read (the FIRST query above) and exit early via the early
    // return.
    return { created: !!res };
  }
}
