import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';

interface MigrationResult {
  orphanProfilesDeleted: number;
  danglingConnectionsDeleted: number;
  danglingRequestsDeleted: number;
  danglingFollowsDeleted: number;
  errors: string[];
}

/**
 * Migration 0044 (ADR-0003) — purge orphaned Connect profiles.
 *
 * BEFORE: a `connectprofiles` row could outlive its owning `users` row (an
 * account hard-deleted outside the anonymize-don't-delete erasure flow, or
 * leftover seeded-demo data whose User was removed while the profile lingered).
 * Such an ORPHAN profile has a `userId` that resolves to no live User. The
 * suggestion engine builds its candidate pool from `connectprofiles` alone
 * (visibility:'public') and never joined User, so an orphan surfaced as a
 * "people you may know" entry that then hydrated to nothing — the web rendered
 * an empty "Connect member" ghost row. SuggestionService now skips such ids at
 * read time (the live-owner guard, ADR-0003); this unit removes the stale data
 * itself so the orphan rows (and their dangling graph edges) stop existing.
 *
 * THIS UNIT (run once, idempotent): finds every `connectprofiles.userId` with no
 * matching `users._id` and deletes (a) those orphan profiles and (b) the now-
 * dangling network-graph edges that reference them — `connectconnections`,
 * `connectconnectionrequests`, `connectfollows` — so a real user's connections /
 * followers lists no longer point at a non-existent person. Re-running finds no
 * orphans → no-op.
 *
 * SCOPE (deliberately narrow): only the profile + the three first-degree graph
 * edges that directly reference the missing user. Broader demo CONTENT
 * (posts / listings / jobs / threads) is owned and cascaded by the demo-purge
 * tooling (AdminConnectDemoService / scripts/connect-demo), which matches on the
 * `isDemo` flag; this unit does not duplicate that. A properly ERASED account is
 * NOT an orphan (erasure keeps the anonymized "Deleted user" User row and flips
 * its profile to visibility:'hidden'), so this never touches erased accounts.
 *
 * Uses the raw Mongo connection + canonical collection names (mirrors
 * AdminConnectDemoService) so the migrations module needs no extra model wiring.
 *
 * Dependency note: reads `users` + `connectprofiles`; writes `connectprofiles`,
 * `connectconnections`, `connectconnectionrequests`, `connectfollows`. Run via
 * `npm run migrate` (ADR-0001 ledgered runner), unit
 * `0044_connect_purge_orphan_profiles`.
 */
@Injectable()
export class PurgeOrphanConnectProfilesService {
  private readonly logger = new Logger(PurgeOrphanConnectProfilesService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private col(name: string) {
    const db = this.connection.db;
    if (!db) throw new Error('Mongo connection not ready');
    return db.collection(name);
  }

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      orphanProfilesDeleted: 0,
      danglingConnectionsDeleted: 0,
      danglingRequestsDeleted: 0,
      danglingFollowsDeleted: 0,
      errors: [],
    };

    try {
      // Every distinct profile owner, then the subset that still exists as a User.
      // The difference is the orphan set (profile present, owning User gone).
      const profileUserIds = (await this.col('connectprofiles').distinct(
        'userId',
      )) as Types.ObjectId[];
      if (profileUserIds.length === 0) {
        this.logger.log('No Connect profiles found (nothing to check).');
        return result;
      }

      const liveUsers = await this.col('users')
        .find({ _id: { $in: profileUserIds } }, { projection: { _id: 1 } })
        .toArray();
      const liveIds = new Set(liveUsers.map((u) => String(u._id)));
      const orphanIds = profileUserIds.filter((id) => !liveIds.has(String(id)));

      if (orphanIds.length === 0) {
        this.logger.log('No orphaned Connect profiles found (already clean).');
        return result;
      }

      // (a) The orphan profiles themselves — the rows that leaked into suggestions.
      const profiles = await this.col('connectprofiles').deleteMany({
        userId: { $in: orphanIds },
      });
      result.orphanProfilesDeleted = profiles.deletedCount ?? 0;

      // (b) Dangling first-degree graph edges that reference the missing user, so a
      //     real user's network lists stop pointing at a non-existent person.
      const connections = await this.col('connectconnections').deleteMany({
        $or: [{ userA: { $in: orphanIds } }, { userB: { $in: orphanIds } }],
      });
      result.danglingConnectionsDeleted = connections.deletedCount ?? 0;

      const requests = await this.col('connectconnectionrequests').deleteMany({
        $or: [{ fromUserId: { $in: orphanIds } }, { toUserId: { $in: orphanIds } }],
      });
      result.danglingRequestsDeleted = requests.deletedCount ?? 0;

      const follows = await this.col('connectfollows').deleteMany({
        $or: [{ followerId: { $in: orphanIds } }, { followeeId: { $in: orphanIds } }],
      });
      result.danglingFollowsDeleted = follows.deletedCount ?? 0;

      this.logger.log(
        `Purged ${result.orphanProfilesDeleted} orphan Connect profile(s) ` +
          `(${orphanIds.length} orphan owner id(s)) + dangling edges: ` +
          `${result.danglingConnectionsDeleted} connection(s), ` +
          `${result.danglingRequestsDeleted} request(s), ` +
          `${result.danglingFollowsDeleted} follow(s).`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to purge orphan Connect profiles: ${detail}`);
      result.errors.push(`purge: ${detail}`);
    }

    return result;
  }
}
