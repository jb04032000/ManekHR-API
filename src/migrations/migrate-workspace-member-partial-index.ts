import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WorkspaceMember } from '../modules/workspaces/schemas/workspace-member.schema';

interface MigrationResult {
  newPartialIndexEnsured: boolean;
  legacySparseIndexDropped: boolean;
  legacySparseIndexAbsent: boolean;
  lookupIndexEnsured: boolean;
  errors: string[];
}

/**
 * P1.1 (2026-05-14) — online dual-index swap for WorkspaceMember.
 *
 * Goal: replace the legacy `{workspaceId:1, userId:1}` SPARSE-unique index
 * (which fails to exclude `userId: null` rows because Mongo `sparse` only
 * skips MISSING fields) with a PARTIAL-unique index that filters on
 * `userId: {$type: 'objectId'}`. Eliminates the E11000 collision path that
 * triggers when two identifier-only invites (both `userId: null`) exist in
 * the same workspace.
 *
 * Strategy (zero downtime per owner Q1 decision 2026-05-14):
 *   1. Ensure the new partial-unique index `workspaceId_userId_partial_unique_v2`
 *      exists. `createIndex` is idempotent — no-op if already present.
 *      Build runs in background; the migration awaits completion.
 *   2. Drop the legacy `workspaceId_1_userId_1` index by name, but ONLY after
 *      confirming the new one is built. If the legacy index is already gone
 *      (fresh DB), the drop is skipped.
 *   3. Ensure the compound lookup index for the post-signup invite-binding
 *      sweep also exists.
 *
 * Safe to re-run on every boot. Mirrors the pro→growth + team-app-access
 * backfill pattern in MigrationsModule.onModuleInit.
 */
@Injectable()
export class MigrateWorkspaceMemberPartialIndexService {
  private readonly logger = new Logger(MigrateWorkspaceMemberPartialIndexService.name);
  private static readonly LEGACY_INDEX_NAME = 'workspaceId_1_userId_1';
  private static readonly NEW_PARTIAL_INDEX_NAME = 'workspaceId_userId_partial_unique_v2';
  private static readonly LOOKUP_INDEX_NAME = 'workspaceId_inviteeIdentifier_status_lookup';

  constructor(
    @InjectModel(WorkspaceMember.name)
    private memberModel: Model<WorkspaceMember>,
  ) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      newPartialIndexEnsured: false,
      legacySparseIndexDropped: false,
      legacySparseIndexAbsent: false,
      lookupIndexEnsured: false,
      errors: [],
    };

    const collection = this.memberModel.collection;

    // ── Step 1 — ensure new partial-unique index exists ────────────────────
    try {
      await collection.createIndex(
        { workspaceId: 1, userId: 1 },
        {
          name: MigrateWorkspaceMemberPartialIndexService.NEW_PARTIAL_INDEX_NAME,
          unique: true,
          partialFilterExpression: { userId: { $type: 'objectId' } },
        },
      );
      result.newPartialIndexEnsured = true;
    } catch (err) {
      const e = err as Error;
      const msg = `Failed to ensure new partial-unique index: ${e?.message ?? String(err)}`;
      this.logger.error(msg, e?.stack);
      result.errors.push(msg);
      // Without the new index, do NOT drop the old one — that would leave
      // the collection without uniqueness enforcement and silently allow
      // duplicate (workspaceId, userId) rows to accumulate.
      return result;
    }

    // ── Step 2 — drop legacy sparse-unique index if present ────────────────
    let existingIndexes: Array<{ name?: string }>;
    try {
      existingIndexes = await collection.indexes();
    } catch (err) {
      const e = err as Error;
      const msg = `Failed to list indexes: ${e?.message ?? String(err)}`;
      this.logger.error(msg, e?.stack);
      result.errors.push(msg);
      return result;
    }

    const hasLegacy = existingIndexes.some(
      (idx) => idx.name === MigrateWorkspaceMemberPartialIndexService.LEGACY_INDEX_NAME,
    );

    if (hasLegacy) {
      try {
        await collection.dropIndex(MigrateWorkspaceMemberPartialIndexService.LEGACY_INDEX_NAME);
        result.legacySparseIndexDropped = true;
        this.logger.log(
          `Dropped legacy index ${MigrateWorkspaceMemberPartialIndexService.LEGACY_INDEX_NAME}; ` +
            `new partial-unique ${MigrateWorkspaceMemberPartialIndexService.NEW_PARTIAL_INDEX_NAME} is now sole guard.`,
        );
      } catch (err) {
        const e = err as Error;
        const msg = `Failed to drop legacy index ${MigrateWorkspaceMemberPartialIndexService.LEGACY_INDEX_NAME}: ${e?.message ?? String(err)}`;
        this.logger.error(msg, e?.stack);
        result.errors.push(msg);
        // New index is built and active; leaving the old one in place is
        // safe (just costs storage). Continue rather than abort.
      }
    } else {
      result.legacySparseIndexAbsent = true;
    }

    // ── Step 3 — ensure compound lookup index for post-signup sweep ────────
    try {
      await collection.createIndex(
        { workspaceId: 1, inviteeIdentifier: 1, status: 1 },
        { name: MigrateWorkspaceMemberPartialIndexService.LOOKUP_INDEX_NAME },
      );
      result.lookupIndexEnsured = true;
    } catch (err) {
      const e = err as Error;
      const msg = `Failed to ensure lookup index ${MigrateWorkspaceMemberPartialIndexService.LOOKUP_INDEX_NAME}: ${e?.message ?? String(err)}`;
      this.logger.error(msg, e?.stack);
      result.errors.push(msg);
    }

    return result;
  }
}
