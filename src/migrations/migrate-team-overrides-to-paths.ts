import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TeamMember } from '../modules/team/schemas/team-member.schema';
import { flatTeamOverrideToPathOverrides } from '../modules/rbac/permission-path.converter';
import type { PathOverride } from '../modules/rbac/permission-path-overrides';

/** Minimal flat-override shape the migration reads from the DB document. */
export interface FlatOverrideShape {
  module: string;
  action: string;
  allowed: boolean;
  scope?: 'self' | 'all';
}

interface MigrationResult {
  migrated: number;
  skipped: number;
  errors: string[];
  dryRun: boolean;
}

/**
 * RBAC re-architecture Phase 1c — convert flat `permissionOverrides` entries
 * whose `module === 'team'` into granular `permissionPathOverrides`.
 *
 * Background: `RolesGuard` / `CallerScopeService` now resolve Team-module
 * permissions from `permissionPathOverrides` (path model) rather than the
 * legacy coarse flat entries. This migration moves every existing
 * `module === 'team'` flat override into path overrides so that member
 * permissions are preserved when the new guard goes live.
 *
 * Per-document logic (`transformMemberOverrides`):
 *   - Split the member's `permissionOverrides` into `team` entries and the rest.
 *   - Convert team entries via `flatTeamOverrideToPathOverrides`:
 *       - allow  → curated non-sensitive leaf paths (same as the existing
 *                  flat→path projection; sensitive groups re-tuned via matrix).
 *       - deny   → EVERY leaf the coarse action governed (deny is never weakened).
 *   - Concatenate the resulting path overrides onto any existing
 *     `permissionPathOverrides` (preserving prior explicit path entries).
 *   - Update the doc: `permissionOverrides` becomes only the non-team entries,
 *     `permissionPathOverrides` gains the expanded paths.
 *
 * Idempotency: a doc with no `module === 'team'` flat entries is skipped
 * entirely. Re-running after the first pass finds no team entries in
 * `permissionOverrides` (they were removed) and produces zero writes.
 *
 * Dry-run: pass `dryRun: true` to `run()` to log what WOULD be updated
 * without writing to the DB. Wire to `--dry-run` via the bootstrap runner.
 *
 * Deploy checklist: run this migration BEFORE the new backend serves traffic
 * (i.e. before the Phase 1c guard reads permissionPathOverrides for Team).
 */
@Injectable()
export class MigrateTeamOverridesToPathsService {
  private readonly logger = new Logger(MigrateTeamOverridesToPathsService.name);

  constructor(@InjectModel(TeamMember.name) private readonly teamModel: Model<TeamMember>) {}

  async run(dryRun = false): Promise<MigrationResult> {
    const result: MigrationResult = { migrated: 0, skipped: 0, errors: [], dryRun };

    // Only fetch members that have at least one flat `module === 'team'` entry
    // so the cursor stays small (most members have no overrides at all).
    const candidates = await this.teamModel.find({ 'permissionOverrides.module': 'team' }).exec();

    for (const member of candidates) {
      try {
        const transformed = transformMemberOverrides({
          permissionOverrides: member.permissionOverrides,
          permissionPathOverrides: member.permissionPathOverrides,
        });

        if (transformed === null) {
          result.skipped++;
          continue;
        }

        const teamCount = member.permissionOverrides.filter((o) => o.module === 'team').length;
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const wsId = String(member.workspaceId);
        this.logger.log(
          `[${dryRun ? 'DRY-RUN' : 'MIGRATE'}] ` +
            `workspaceId=${wsId} ` +
            `memberId=${String(member._id)} ` +
            `teamFlatEntries=${teamCount} ` +
            `→ permissionPathOverrides.length=${transformed.permissionPathOverrides.length}`,
        );

        if (!dryRun) {
          await this.teamModel.updateOne(
            { _id: member._id },
            {
              $set: {
                permissionOverrides: transformed.permissionOverrides,
                permissionPathOverrides: transformed.permissionPathOverrides,
              },
            },
          );
        }

        result.migrated++;
      } catch (err) {
        const message = `member ${String(member._id)}: ${(err as Error)?.message ?? String(err)}`;
        result.errors.push(message);
        this.logger.warn(`MigrateTeamOverridesToPaths error — ${message}`);
      }
    }

    this.logger.log(
      `migrated ${result.migrated} members, skipped ${result.skipped}, dryRun=${dryRun}`,
    );

    return result;
  }
}

/**
 * Pure per-document transform — exported for unit testing without a DB.
 *
 * Returns `null` when there is nothing to migrate (no `team` flat entries →
 * the caller should skip this document). Otherwise returns the new values for
 * both fields (inputs are NOT mutated).
 */
export function transformMemberOverrides(member: {
  permissionOverrides?: FlatOverrideShape[];
  permissionPathOverrides?: PathOverride[];
}): { permissionOverrides: FlatOverrideShape[]; permissionPathOverrides: PathOverride[] } | null {
  const flatOverrides = member.permissionOverrides ?? [];
  const teamEntries = flatOverrides.filter((o) => o.module === 'team');

  // Nothing to migrate — idempotent skip.
  if (teamEntries.length === 0) return null;

  const otherEntries = flatOverrides.filter((o) => o.module !== 'team');
  const existingPathOverrides = member.permissionPathOverrides ?? [];

  const expandedPaths: PathOverride[] = teamEntries.flatMap(flatTeamOverrideToPathOverrides);
  const newPathOverrides: PathOverride[] = [...existingPathOverrides, ...expandedPaths];

  return {
    permissionOverrides: otherEntries,
    permissionPathOverrides: newPathOverrides,
  };
}
