import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Workspace } from '../modules/workspaces/schemas/workspace.schema';
import { Role } from '../modules/rbac/schemas/role.schema';
import { DEFAULT_ROLES } from '../modules/rbac/role-seeder.constants';

interface MigrationResult {
  workspacesScanned: number;
  rolesCreated: number;
  workspacesSkipped: number;
  errors: string[];
}

/**
 * Wave 4.11 (2026-05-10) — backfill canonical default roles for existing
 * workspaces.
 *
 * For every workspace, ensure each role in `DEFAULT_ROLES` (Member, Worker,
 * Manager, HR) exists. Uses the same upsert key (`workspaceId`, `name`) as
 * `RoleSeederService.seedDefaultRolesForWorkspace` so concurrent boot +
 * workspace-create paths converge.
 *
 * Idempotent — safe to re-run. Runs unconditionally on bootstrap (mirrors
 * the W2.8 team-app-access backfill pattern + pro→growth migration).
 */
@Injectable()
export class SeedDefaultMemberRoleExistingWorkspacesService {
  private readonly logger = new Logger(SeedDefaultMemberRoleExistingWorkspacesService.name);

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(Role.name) private readonly roleModel: Model<Role>,
  ) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      workspacesScanned: 0,
      rolesCreated: 0,
      workspacesSkipped: 0,
      errors: [],
    };

    const workspaces = await this.workspaceModel.find({}, { _id: 1 }).lean().exec();

    for (const ws of workspaces) {
      result.workspacesScanned++;
      // ws._id is Mongoose's ObjectId on a lean<Workspace>() result; pass
      // it directly to the role queries — Mongoose accepts both ObjectId
      // and string forms in filters and casts internally.
      const workspaceId = ws._id;
      let createdHere = 0;

      for (const def of DEFAULT_ROLES) {
        try {
          const existing = await this.roleModel.findOne({ workspaceId, name: def.name }).exec();
          if (existing) continue;

          await this.roleModel.findOneAndUpdate(
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
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
          createdHere++;
          result.rolesCreated++;
        } catch (err) {
          const message = `workspace ${workspaceId.toString()} role ${def.name}: ${
            (err as Error)?.message ?? err
          }`;
          result.errors.push(message);
          this.logger.warn(`Backfill error — ${message}`);
        }
      }

      if (createdHere === 0) {
        result.workspacesSkipped++;
      }
    }

    return result;
  }
}
