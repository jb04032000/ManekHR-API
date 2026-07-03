import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';

interface MigrationResult {
  demoOwnerCount: number;
  postsStamped: number;
  listingsStamped: number;
  jobsStamped: number;
  jobApplicationsStamped: number;
  rfqsStamped: number;
  quotesStamped: number;
  errors: string[];
}

/**
 * Migration 0048 (Demo-Content Scope B) — backfill `isDemo:true` on existing
 * Connect content docs owned by a seeded demo/sample account.
 *
 * BACKGROUND: Connect content docs (Post / Listing / Job / JobApplication /
 * Rfq / Quote) now carry a denormalized `isDemo:boolean` (default false),
 * STAMPED AT CREATE from the author's `User.isDemo` (mirrors how
 * `authorErpLinked` is denormalized on Post). That denormalized flag is the
 * single source both the FE "Sample" badge and the feed/search demo down-rank
 * read. Content created BEFORE this field existed has no flag, so demo-seeded
 * rows would render with no badge and rank like real content.
 *
 * THE MARKER (Demo-Content Scope B, shared everywhere): an account is demo when
 * its `users.isDemo === true` OR its `users.email` ends with
 * `@connect-demo.zari360.test`. Real accounts have `isDemo` false/absent and a
 * real email — they are NEVER touched (their `isDemo` stays false).
 *
 * THIS UNIT (run once, idempotent): resolve the demo USER id set from `users`,
 * then raw-update each content collection, setting `isDemo:true` ONLY on rows
 * whose owner id is in that set AND that are not already stamped
 * (`isDemo: { $ne: true }`), keyed on each collection's owner field:
 *   - connectposts            → authorId
 *   - connect_listings        → ownerUserId
 *   - connect_jobs            → companyUserId
 *   - connect_job_applications→ applicantUserId
 *   - connect_rfqs            → buyerUserId
 *   - connect_quotes          → sellerUserId
 * Re-running finds those rows already stamped → 0 modified (the `$ne: true`
 * guard keeps it a no-op the second time).
 *
 * Uses the raw Mongo connection + canonical collection names (mirrors
 * PurgeOrphanConnectProfilesService / AdminConnectDemoService) so the migrations
 * module needs no extra model wiring.
 *
 * Dependency note: reads `users`; writes `connectposts`, `connect_listings`,
 * `connect_jobs`, `connect_job_applications`, `connect_rfqs`, `connect_quotes`.
 * Run via `npm run migrate` (ADR-0001 ledgered runner), unit
 * `0048_connect_backfill_content_is_demo`.
 */
@Injectable()
export class BackfillConnectContentIsDemoService {
  private readonly logger = new Logger(BackfillConnectContentIsDemoService.name);

  // Same demo marker as the sitemap exclusion, the auction hard-gate
  // (ad-repos.ts), and the FE "Sample" badge — one definition everywhere.
  private static readonly DEMO_EMAIL_SUFFIX = '@connect-demo.zari360.test';

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private col(name: string) {
    const db = this.connection.db;
    if (!db) throw new Error('Mongo connection not ready');
    return db.collection(name);
  }

  /** Stamp `isDemo:true` on `collection` rows whose `ownerField` is a demo id. */
  private async stamp(
    collection: string,
    ownerField: string,
    demoOwnerIds: Types.ObjectId[],
  ): Promise<number> {
    const res = await this.col(collection).updateMany(
      // `$ne: true` keeps re-runs a no-op and leaves any real doc untouched.
      { [ownerField]: { $in: demoOwnerIds }, isDemo: { $ne: true } },
      { $set: { isDemo: true } },
    );
    return res.modifiedCount ?? 0;
  }

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      demoOwnerCount: 0,
      postsStamped: 0,
      listingsStamped: 0,
      jobsStamped: 0,
      jobApplicationsStamped: 0,
      rfqsStamped: 0,
      quotesStamped: 0,
      errors: [],
    };

    try {
      // Resolve the demo user id set: isDemo:true OR demo email suffix.
      const demoUsers = await this.col('users')
        .find(
          {
            $or: [
              { isDemo: true },
              {
                email: {
                  $regex: `${BackfillConnectContentIsDemoService.DEMO_EMAIL_SUFFIX.replace(
                    /[.]/g,
                    '\\.',
                  )}$`,
                },
              },
            ],
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      const demoOwnerIds = demoUsers.map((u) => u._id as Types.ObjectId);
      result.demoOwnerCount = demoOwnerIds.length;

      if (demoOwnerIds.length === 0) {
        this.logger.log('No demo accounts found — no Connect content to stamp.');
        return result;
      }

      result.postsStamped = await this.stamp('connectposts', 'authorId', demoOwnerIds);
      result.listingsStamped = await this.stamp('connect_listings', 'ownerUserId', demoOwnerIds);
      result.jobsStamped = await this.stamp('connect_jobs', 'companyUserId', demoOwnerIds);
      result.jobApplicationsStamped = await this.stamp(
        'connect_job_applications',
        'applicantUserId',
        demoOwnerIds,
      );
      result.rfqsStamped = await this.stamp('connect_rfqs', 'buyerUserId', demoOwnerIds);
      result.quotesStamped = await this.stamp('connect_quotes', 'sellerUserId', demoOwnerIds);

      this.logger.log(
        `Stamped isDemo:true on demo-owned Connect content ` +
          `(${result.demoOwnerCount} demo owner id(s)): ` +
          `${result.postsStamped} post(s), ${result.listingsStamped} listing(s), ` +
          `${result.jobsStamped} job(s), ${result.jobApplicationsStamped} application(s), ` +
          `${result.rfqsStamped} rfq(s), ${result.quotesStamped} quote(s).`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to backfill Connect content isDemo: ${detail}`);
      result.errors.push(`backfill: ${detail}`);
    }

    return result;
  }
}
