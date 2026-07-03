import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';

interface MigrationResult {
  liveOwnerIds: number;
  ownersSetTrue: number;
  nonOwnersSetFalse: number;
  errors: string[];
}

/**
 * Migration 0046 — backfill `User.hasWorkspace` from real workspace ownership.
 *
 * BUG: `hasWorkspace` was only ever SET true on workspace-create and never
 * recomputed ("set on create, never enforced"). So a user who deleted their last
 * workspace kept hasWorkspace=true, and a legacy/oddly-created account could read
 * as `undefined` (not an explicit `false`). The web post-login redirect treats a
 * non-`false` flag as "ERP user" and routes them into the ERP shell, which then
 * forces Quick-PIN (App Lock) setup -- even though they have NO workspace and
 * Connect has no PIN. Net effect: a Connect-only account is parked on the
 * `/auth/setup-pin` screen.
 *
 * THIS UNIT (run once, idempotent): recompute every user's flag from the truth =
 * "owns at least one live (non-deleted) workspace":
 *   - users who own a live workspace AND don't already read true  -> set true.
 *   - everyone else whose flag is not already an explicit false    -> set false
 *     (this covers BOTH the stale-true after-delete case AND the never-set /
 *     `undefined` case, since `{$ne:false}` also matches a missing field).
 * Re-running finds no rows matching the `$ne` filters -> 0 writes (no-op).
 *
 * Going forward the flag is kept accurate by WorkspacesService.recomputeHasWorkspace
 * (called on create / remove / restore). The web setup-pin guard cross-checks the
 * real workspace list as defence-in-depth.
 *
 * Scope: membership-only access (a non-owner active member) is deliberately NOT
 * counted as "has a workspace" here -- that preserves the existing flag semantics
 * (owner-only) and avoids suddenly routing every worker into the ERP shell + PIN.
 *
 * Uses the raw Mongo connection + canonical collection names (mirrors
 * PurgeOrphanConnectProfilesService) so the migrations module needs no extra
 * model wiring. Reads `workspaces`; writes `users`. Run via `npm run migrate`
 * (ADR-0001 ledgered runner), unit `0046_users_backfill_has_workspace`.
 */
@Injectable()
export class BackfillUserHasWorkspaceService {
  private readonly logger = new Logger(BackfillUserHasWorkspaceService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private col(name: string) {
    const db = this.connection.db;
    if (!db) throw new Error('Mongo connection not ready');
    return db.collection(name);
  }

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      liveOwnerIds: 0,
      ownersSetTrue: 0,
      nonOwnersSetFalse: 0,
      errors: [],
    };

    try {
      // Every distinct owner of a live (non-deleted) workspace.
      const liveOwnerIds = (await this.col('workspaces').distinct('ownerId', {
        isDeleted: { $ne: true },
      })) as Types.ObjectId[];
      result.liveOwnerIds = liveOwnerIds.length;

      // Owners of a live workspace -> hasWorkspace must be true.
      const ownersTrue = await this.col('users').updateMany(
        { _id: { $in: liveOwnerIds }, hasWorkspace: { $ne: true } },
        { $set: { hasWorkspace: true } },
      );
      result.ownersSetTrue = ownersTrue.modifiedCount ?? 0;

      // Everyone else -> hasWorkspace must be an explicit false. `$ne: false`
      // also matches a MISSING field, so this normalizes the `undefined` legacy
      // case (the one the FE `=== false` redirect check needs) in the same pass.
      const nonOwnersFalse = await this.col('users').updateMany(
        { _id: { $nin: liveOwnerIds }, hasWorkspace: { $ne: false } },
        { $set: { hasWorkspace: false } },
      );
      result.nonOwnersSetFalse = nonOwnersFalse.modifiedCount ?? 0;

      this.logger.log(
        `Backfilled User.hasWorkspace from ${result.liveOwnerIds} live-workspace owner id(s): ` +
          `${result.ownersSetTrue} -> true, ${result.nonOwnersSetFalse} -> false.`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to backfill User.hasWorkspace: ${detail}`);
      result.errors.push(`backfill: ${detail}`);
    }

    return result;
  }
}
