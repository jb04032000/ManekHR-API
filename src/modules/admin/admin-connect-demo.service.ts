import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * Admin "Connect demo manager" service.
 *
 * Lists, removes and posts-as the seeded Connect demo accounts (see
 * `scripts/seed-connect.ts`). Demo data is matched by `isDemo: true` OR the
 * demo email domain, so real users (`isDemo: false`) are never touched. Uses
 * the raw Mongo connection + the canonical collection names (mirrors the
 * cascade in `scripts/connect-demo/models.ts > purgeDemo`) rather than wiring
 * ~20 Mongoose models into the admin module.
 *
 * SAFE PURGE (Scope B, 2026-06-21) — cleanup is MANUAL (the owner triggers it
 * from the admin Demo Manager) but must NEVER wipe a real user's history. Before
 * any hard delete we classify each demo account:
 *   - CLEAN     — no real user has ever interacted with it (no shared thread /
 *                 connection / connection-request / follow / job application /
 *                 inquiry / quote with a non-demo user). Hard-purge as before.
 *   - ENTANGLED — a real user shares one of the above with the demo account.
 *                 We do NOT hard-delete it (that would orphan the real user's
 *                 thread/edge into a ghost). Instead we convert the demo account
 *                 to a permanent anonymized "Sample account no longer available"
 *                 stub (mirrors the anonymize-don't-delete pattern in
 *                 `auth/services/account-erasure.service.ts`): isActive=false,
 *                 deletedAt set, email/mobile nulled (sparse-unique safe), name
 *                 stub. Its OWN content with no real entanglement (posts /
 *                 listings / jobs / rfqs / storefronts / company pages) is still
 *                 deleted; its shared threads/edges are KEPT so the real user's
 *                 thread renders (reply disabled FE-side) and edges resolve to a
 *                 stub, not a dangling id.
 *
 * When unsure whether a thing is entangled we treat it as ENTANGLED (stub, never
 * hard-delete) — conservative by design (this is security-sensitive).
 *
 * Linked to: admin-connect-demo.controller.ts (clearAll / deleteUser / dryRun).
 */

const DEMO_DOMAIN = '@connect-demo.zari360.test';
const DEMO_OR: Record<string, unknown>[] = [
  { isDemo: true },
  { email: { $regex: `${DEMO_DOMAIN.replace('.', '\\.')}$` } },
];

/** Quote statuses that count as "live" for the RFQ board's denormalized
 *  quotesCount + lowestQuotePrice — must match LIVE_QUOTE_STATUSES in
 *  connect/rfq/rfq.service.ts (cross-module link: the recompute below re-derives
 *  the SAME tallies the live service maintains incrementally). */
const LIVE_QUOTE_STATUSES = ['sent', 'shortlisted', 'accepted'] as const;

export interface DemoUserRow {
  id: string;
  name: string;
  mobile: string;
  handle: string;
  headline: string;
  posts: number;
  listings: number;
  jobs: number;
  loginOtp: string;
}

/** One collection's delete tally in a dry-run report. */
export interface DemoPurgeReportRow {
  collection: string;
  /** Rows that WOULD be deleted (CLEAN accounts' everything + ENTANGLED
   *  accounts' own non-shared content). */
  toDelete: number;
}

/** What `dryRun()` returns WITHOUT mutating anything. */
export interface DemoPurgeReport {
  /** Total demo accounts matched. */
  demoAccounts: number;
  /** Demo accounts that would be HARD-deleted (no real-user entanglement). */
  hardDeleted: number;
  /** Demo accounts that would become anonymized stubs (real-user entanglement). */
  stubbed: number;
  /** Per-collection counts of rows that would be deleted. */
  rows: DemoPurgeReportRow[];
}

@Injectable()
export class AdminConnectDemoService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly audit: AuditService,
  ) {}

  private col(name: string) {
    const db = this.connection.db;
    if (!db) throw new Error('Mongo connection not ready');
    return db.collection(name);
  }

  private async demoUserIds(): Promise<Types.ObjectId[]> {
    const rows = await this.col('users')
      .find({ $or: DEMO_OR }, { projection: { _id: 1 } })
      .toArray();
    return rows.map((r) => r._id as Types.ObjectId);
  }

  /** List every demo account with its login + content counts. */
  async listUsers(): Promise<DemoUserRow[]> {
    const users = await this.col('users')
      .find({ $or: DEMO_OR }, { projection: { _id: 1, name: 1, mobile: 1, handle: 1 } })
      .sort({ mobile: 1 })
      .toArray();

    const ids = users.map((u) => u._id as Types.ObjectId);
    const profiles = await this.col('connectprofiles')
      .find({ userId: { $in: ids } }, { projection: { userId: 1, headline: 1 } })
      .toArray();
    const headlineByUser = new Map<string, string>();
    for (const p of profiles) headlineByUser.set(String(p.userId), (p.headline as string) ?? '');

    const out: DemoUserRow[] = [];
    for (const u of users) {
      const uid = u._id as Types.ObjectId;
      const [posts, listings, jobs] = await Promise.all([
        this.col('connectposts').countDocuments({ authorId: uid }),
        this.col('connect_listings').countDocuments({ ownerUserId: uid }),
        this.col('connect_jobs').countDocuments({ companyUserId: uid }),
      ]);
      out.push({
        id: String(uid),
        name: (u.name as string) ?? '',
        mobile: (u.mobile as string) ?? '',
        handle: (u.handle as string) ?? '',
        headline: headlineByUser.get(String(uid)) ?? '',
        posts,
        listings,
        jobs,
        loginOtp: '123456',
      });
    }
    return out;
  }

  /**
   * Partition a set of demo ids into CLEAN (no real-user interaction) vs
   * ENTANGLED (a real user shares a thread / connection / connection-request /
   * follow / job application / inquiry / quote with the demo account).
   *
   * The demo-id set is the marker for "the OTHER party is also demo": an edge
   * between two demo accounts is NOT entanglement (both go away together). Only
   * an edge whose counterparty is a NON-demo (real) user makes a demo account
   * entangled. When in doubt we err toward ENTANGLED (never hard-delete).
   *
   * Cross-module links: threads (inbox), connections/requests/follows (network),
   * job applications (jobs), inquiries (marketplace), quotes (rfq).
   */
  private async classify(
    ids: Types.ObjectId[],
  ): Promise<{ clean: Types.ObjectId[]; entangled: Types.ObjectId[] }> {
    const demoSet = new Set(ids.map((id) => String(id)));
    const entangled = new Set<string>();
    const markIfReal = (counterparty: unknown, demoId: unknown): void => {
      // The counterparty is a real user iff it is a valid id NOT in the demo set.
      // (A null/absent counterparty — e.g. a follow targeting a company page — is
      // ignored: it is not a real-user-to-demo edge.)
      const cp = counterparty == null ? '' : String(counterparty);
      if (cp && !demoSet.has(cp)) entangled.add(String(demoId));
    };

    // 1) DM threads — any 2-party thread containing a demo id; the OTHER
    //    participant decides entanglement. participantIds is a User[] of length 2.
    const threads = await this.col('connect_threads')
      .find({ participantIds: { $in: ids } }, { projection: { participantIds: 1 } })
      .toArray();
    for (const t of threads) {
      const parts = (t.participantIds as Types.ObjectId[]) ?? [];
      const demoSides = parts.filter((p) => demoSet.has(String(p)));
      for (const demoSide of demoSides) {
        for (const p of parts) {
          if (String(p) !== String(demoSide)) markIfReal(p, demoSide);
        }
      }
    }

    // 2) Connections (canonical ordered pair userA<userB).
    const conns = await this.col('connectconnections')
      .find(
        { $or: [{ userA: { $in: ids } }, { userB: { $in: ids } }] },
        { projection: { userA: 1, userB: 1 } },
      )
      .toArray();
    for (const c of conns) {
      const a = c.userA;
      const b = c.userB;
      if (demoSet.has(String(a))) markIfReal(b, a);
      if (demoSet.has(String(b))) markIfReal(a, b);
    }

    // 3) Connection requests (sent or received) — any status; a pending request
    //    from/to a real user is still a real-user interaction.
    const reqs = await this.col('connectconnectionrequests')
      .find(
        { $or: [{ fromUserId: { $in: ids } }, { toUserId: { $in: ids } }] },
        { projection: { fromUserId: 1, toUserId: 1 } },
      )
      .toArray();
    for (const r of reqs) {
      if (demoSet.has(String(r.fromUserId))) markIfReal(r.toUserId, r.fromUserId);
      if (demoSet.has(String(r.toUserId))) markIfReal(r.fromUserId, r.toUserId);
    }

    // 4) Follows — a real user following a demo (followeeType 'user'), or a demo
    //    following a real user. A follow targeting a company page (followeeId is
    //    a page, not a user) is ignored on the followee side via the type filter.
    const follows = await this.col('connectfollows')
      .find(
        { $or: [{ followerId: { $in: ids } }, { followeeType: 'user', followeeId: { $in: ids } }] },
        { projection: { followerId: 1, followeeType: 1, followeeId: 1 } },
      )
      .toArray();
    for (const f of follows) {
      // Demo is the follower → counterparty is the followee (only when it is a user).
      if (demoSet.has(String(f.followerId)) && f.followeeType === 'user') {
        markIfReal(f.followeeId, f.followerId);
      }
      // Demo is the followee (a real user follows this demo) → follower is real.
      if (f.followeeType === 'user' && demoSet.has(String(f.followeeId))) {
        markIfReal(f.followerId, f.followeeId);
      }
    }

    // 5) Job applications — a real karigar applied to a demo's job, OR a demo
    //    applied to a real company's job. We resolve job ownership to find the
    //    other side for the demo-applicant case.
    const apps = await this.col('connect_job_applications')
      .find({ applicantUserId: { $in: ids } }, { projection: { applicantUserId: 1, jobId: 1 } })
      .toArray();
    // (a) demo as applicant: the job's owner is the counterparty.
    const appJobIds = apps.map((a) => a.jobId as Types.ObjectId);
    const appJobs =
      appJobIds.length > 0
        ? await this.col('connect_jobs')
            .find({ _id: { $in: appJobIds } }, { projection: { _id: 1, companyUserId: 1 } })
            .toArray()
        : [];
    const jobOwnerById = new Map<string, unknown>();
    for (const j of appJobs) jobOwnerById.set(String(j._id), j.companyUserId);
    for (const a of apps) {
      markIfReal(jobOwnerById.get(String(a.jobId)), a.applicantUserId);
    }
    // (b) real applicant on a demo's job: any application whose APPLICANT is real,
    //     on a job owned by a demo.
    const demoJobs = await this.col('connect_jobs')
      .find({ companyUserId: { $in: ids } }, { projection: { _id: 1, companyUserId: 1 } })
      .toArray();
    const demoJobIds = demoJobs.map((j) => j._id as Types.ObjectId);
    const demoJobOwnerById = new Map<string, unknown>();
    for (const j of demoJobs) demoJobOwnerById.set(String(j._id), j.companyUserId);
    if (demoJobIds.length > 0) {
      const appsOnDemoJobs = await this.col('connect_job_applications')
        .find({ jobId: { $in: demoJobIds } }, { projection: { applicantUserId: 1, jobId: 1 } })
        .toArray();
      for (const a of appsOnDemoJobs) {
        markIfReal(a.applicantUserId, demoJobOwnerById.get(String(a.jobId)));
      }
    }

    // 6) Inquiries — buyer/seller, both denormalized to User ids.
    const inquiries = await this.col('connect_inquiries')
      .find(
        { $or: [{ buyerUserId: { $in: ids } }, { sellerUserId: { $in: ids } }] },
        { projection: { buyerUserId: 1, sellerUserId: 1 } },
      )
      .toArray();
    for (const q of inquiries) {
      if (demoSet.has(String(q.buyerUserId))) markIfReal(q.sellerUserId, q.buyerUserId);
      if (demoSet.has(String(q.sellerUserId))) markIfReal(q.buyerUserId, q.sellerUserId);
    }

    // 7) Quotes — a demo seller quoted a real buyer's RFQ, OR a real seller
    //    quoted a demo's RFQ. The RFQ buyer is resolved from connect_rfqs.
    const quotesBySeller = await this.col('connect_quotes')
      .find({ sellerUserId: { $in: ids } }, { projection: { sellerUserId: 1, rfqId: 1 } })
      .toArray();
    const quoteRfqIds = quotesBySeller.map((q) => q.rfqId as Types.ObjectId);
    const quoteRfqs =
      quoteRfqIds.length > 0
        ? await this.col('connect_rfqs')
            .find({ _id: { $in: quoteRfqIds } }, { projection: { _id: 1, buyerUserId: 1 } })
            .toArray()
        : [];
    const rfqBuyerById = new Map<string, unknown>();
    for (const r of quoteRfqs) rfqBuyerById.set(String(r._id), r.buyerUserId);
    for (const q of quotesBySeller) {
      markIfReal(rfqBuyerById.get(String(q.rfqId)), q.sellerUserId);
    }
    // Real seller quoted a demo's RFQ.
    const demoRfqs = await this.col('connect_rfqs')
      .find({ buyerUserId: { $in: ids } }, { projection: { _id: 1, buyerUserId: 1 } })
      .toArray();
    const demoRfqIds = demoRfqs.map((r) => r._id as Types.ObjectId);
    const demoRfqBuyerById = new Map<string, unknown>();
    for (const r of demoRfqs) demoRfqBuyerById.set(String(r._id), r.buyerUserId);
    if (demoRfqIds.length > 0) {
      const quotesOnDemoRfqs = await this.col('connect_quotes')
        .find({ rfqId: { $in: demoRfqIds } }, { projection: { sellerUserId: 1, rfqId: 1 } })
        .toArray();
      for (const q of quotesOnDemoRfqs) {
        markIfReal(q.sellerUserId, demoRfqBuyerById.get(String(q.rfqId)));
      }
    }

    const clean: Types.ObjectId[] = [];
    const entangledIds: Types.ObjectId[] = [];
    for (const id of ids) {
      if (entangled.has(String(id))) entangledIds.push(id);
      else clean.push(id);
    }
    return { clean, entangled: entangledIds };
  }

  /**
   * Re-derive honest denormalized tallies on the REAL content the now-deleted
   * demo rows had inflated. Shared by every purge path (ADR-0002 — demo
   * views/reactions/comments/quotes/applications used to stay baked into a real
   * record's tallies). Each recompute reads the SURVIVORS, so it matches the live
   * services' incremental maintenance semantics:
   *   - posts: viewCount = unique view edges, reactionCount, commentCount
   *   - rfqs:  quotesCount = LIVE quotes, lowestQuotePrice = min LIVE price
   *   - jobs:  applicationsCount = non-withdrawn applications
   * A record that was itself a demo record (deleted in this purge) → findOne null
   * → skipped.
   */
  private async recomputeAffected(
    affectedPostIds: Types.ObjectId[],
    affectedRfqIds: Types.ObjectId[],
    affectedJobIds: Types.ObjectId[],
  ): Promise<void> {
    for (const postId of affectedPostIds) {
      const post = await this.col('connectposts').findOne(
        { _id: postId },
        { projection: { _id: 1 } },
      );
      if (!post) continue;
      const [viewCount, reactionCount, commentCount] = await Promise.all([
        this.col('connectengagementedges').countDocuments({ postId, type: 'view' }),
        this.col('connectreactions').countDocuments({ postId }),
        this.col('connectcomments').countDocuments({ postId, deletedAt: null }),
      ]);
      await this.col('connectposts').updateOne(
        { _id: postId },
        { $set: { viewCount, reactionCount, commentCount } },
      );
    }

    // RFQ quotesCount + lowestQuotePrice (only LIVE quotes count, matching
    // rfq.service.ts). A demo's OWN RFQ is deleted in CLEAN purge → skipped.
    for (const rfqId of affectedRfqIds) {
      const rfq = await this.col('connect_rfqs').findOne(
        { _id: rfqId },
        { projection: { _id: 1 } },
      );
      if (!rfq) continue;
      const liveFilter = { rfqId, status: { $in: [...LIVE_QUOTE_STATUSES] } };
      const quotesCount = await this.col('connect_quotes').countDocuments(liveFilter);
      const agg = await this.col('connect_quotes')
        .aggregate<{ low: number }>([
          { $match: liveFilter },
          { $group: { _id: null, low: { $min: '$price' } } },
        ])
        .toArray();
      await this.col('connect_rfqs').updateOne(
        { _id: rfqId },
        { $set: { quotesCount, lowestQuotePrice: agg[0]?.low ?? null } },
      );
    }

    // Job applicationsCount = non-withdrawn applications (matching jobs.service.ts).
    for (const jobId of affectedJobIds) {
      const job = await this.col('connect_jobs').findOne(
        { _id: jobId },
        { projection: { _id: 1 } },
      );
      if (!job) continue;
      const applicationsCount = await this.col('connect_job_applications').countDocuments({
        jobId,
        status: { $ne: 'withdrawn' },
      });
      await this.col('connect_jobs').updateOne({ _id: jobId }, { $set: { applicationsCount } });
    }
  }

  /**
   * Capture the REAL records (posts / rfqs / jobs) the demo accounts engaged with
   * BEFORE we strip their engagement, so we can re-derive honest counts after.
   * Returns ids deduped (demo-owned records among them are deleted and skip at
   * recompute time via the findOne-null guard).
   */
  private async collectAffected(ids: Types.ObjectId[]): Promise<{
    posts: Types.ObjectId[];
    rfqs: Types.ObjectId[];
    jobs: Types.ObjectId[];
  }> {
    const dedupe = (arr: unknown[]): Types.ObjectId[] => [
      ...new Map<string, Types.ObjectId>(
        arr.map((id) => [String(id), id as Types.ObjectId]),
      ).values(),
    ];

    const [demoViewedPostIds, demoReactedPostIds, demoCommentedPostIds] = await Promise.all([
      this.col('connectengagementedges').distinct('postId', {
        actorId: { $in: ids },
        type: 'view',
      }),
      this.col('connectreactions').distinct('postId', { userId: { $in: ids } }),
      this.col('connectcomments').distinct('postId', { authorId: { $in: ids } }),
    ]);

    // RFQs a demo SELLER quoted on (their quote rows are deleted below; the RFQ's
    // quotesCount/lowestQuotePrice must be re-derived from survivors).
    const demoQuotedRfqIds = await this.col('connect_quotes').distinct('rfqId', {
      sellerUserId: { $in: ids },
    });
    // Jobs a demo APPLICANT applied to (their application rows are deleted below;
    // the job's applicationsCount must be re-derived).
    const demoAppliedJobIds = await this.col('connect_job_applications').distinct('jobId', {
      applicantUserId: { $in: ids },
    });

    return {
      posts: dedupe([...demoViewedPostIds, ...demoReactedPostIds, ...demoCommentedPostIds]),
      rfqs: dedupe(demoQuotedRfqIds),
      jobs: dedupe(demoAppliedJobIds),
    };
  }

  /**
   * Hard-purge a set of CLEAN demo users and everything they own/touched, then
   * recompute honest counts on the real records they had engaged with. This is
   * the original cascade (now also covering RFQ + job count recompute). Only call
   * with ids that {@link classify} returned as CLEAN.
   */
  private async purgeClean(ids: Types.ObjectId[]): Promise<number> {
    if (ids.length === 0) return 0;

    const affected = await this.collectAffected(ids);

    const ws = await this.col('workspaces')
      .find({ ownerId: { $in: ids } }, { projection: { _id: 1 } })
      .toArray();
    const wsIds = ws.map((w) => w._id as Types.ObjectId);

    await this.col('attendances').deleteMany({ workspaceId: { $in: wsIds } });
    await this.col('workspacemembers').deleteMany({ workspaceId: { $in: wsIds } });
    await this.col('workspaces').deleteMany({ _id: { $in: wsIds } });
    await this.col('connectprofiles').deleteMany({ userId: { $in: ids } });
    await this.col('connectconnections').deleteMany({
      $or: [{ userA: { $in: ids } }, { userB: { $in: ids } }],
    });
    await this.col('connectconnectionrequests').deleteMany({
      $or: [{ fromUserId: { $in: ids } }, { toUserId: { $in: ids } }],
    });
    await this.col('connectfollows').deleteMany({
      $or: [{ followerId: { $in: ids } }, { followeeId: { $in: ids } }],
    });
    await this.col('connectfeedentries').deleteMany({
      $or: [{ ownerId: { $in: ids } }, { authorId: { $in: ids } }],
    });
    // Remove the demo accounts' engagement + seen rows — never cleaned before,
    // so a demo viewer/reactor/commenter left their tally baked into real posts.
    // View edges actored-by OR authored-by a demo user; seen rows by a demo
    // viewer. The real-post tallies are recomputed from survivors at the end.
    await this.col('connectengagementedges').deleteMany({
      $or: [{ actorId: { $in: ids } }, { authorId: { $in: ids } }],
    });
    await this.col('connectseenposts').deleteMany({ viewerId: { $in: ids } });
    await this.col('connectreactions').deleteMany({ userId: { $in: ids } });
    await this.col('connectcomments').deleteMany({ authorId: { $in: ids } });
    await this.col('connectposts').deleteMany({ authorId: { $in: ids } });
    await this.col('connect_listings').deleteMany({ ownerUserId: { $in: ids } });
    await this.col('connect_storefronts').deleteMany({ ownerUserId: { $in: ids } });
    await this.col('connect_company_pages').deleteMany({ ownerUserId: { $in: ids } });
    await this.col('connect_quotes').deleteMany({ sellerUserId: { $in: ids } });
    await this.col('connect_rfqs').deleteMany({ buyerUserId: { $in: ids } });
    await this.col('connect_job_applications').deleteMany({ applicantUserId: { $in: ids } });
    await this.col('connect_jobs').deleteMany({ companyUserId: { $in: ids } });

    const threads = await this.col('connect_threads')
      .find({ participantIds: { $in: ids } }, { projection: { _id: 1 } })
      .toArray();
    const threadIds = threads.map((t) => t._id as Types.ObjectId);
    await this.col('connect_messages').deleteMany({ threadId: { $in: threadIds } });
    await this.col('connect_threads').deleteMany({ _id: { $in: threadIds } });
    await this.col('connect_inquiries').deleteMany({
      $or: [{ buyerUserId: { $in: ids } }, { sellerUserId: { $in: ids } }],
    });

    const res = await this.col('users').deleteMany({ _id: { $in: ids } });

    // Re-derive honest denormalized tallies on the REAL records the demo accounts
    // engaged with, from the survivors (demo edges/reactions/comments/quotes/
    // applications are now gone). A demo-owned record in this set was deleted
    // above → findOne null → skipped.
    await this.recomputeAffected(affected.posts, affected.rfqs, affected.jobs);

    return res.deletedCount ?? ids.length;
  }

  /**
   * ENTANGLED demo accounts: a real user shares a thread/edge with them, so we
   * MUST NOT hard-delete (that would leave the real user's thread/edge dangling).
   * Instead:
   *   - Delete the demo's OWN, non-shared content (posts, listings, storefronts,
   *     company pages, jobs, rfqs, feed entries, own seen/engagement/reactions/
   *     comments) — same as a CLEAN purge MINUS the relationship rows.
   *   - KEEP the shared relationship rows (threads, messages, connections,
   *     requests, follows, inquiries, quotes, job applications) so the real
   *     user's history stays whole and resolves to the stub below.
   *   - Convert the User doc to a permanent anonymized stub ("Sample account no
   *     longer available"): isActive=false, deletedAt set, email/mobile nulled
   *     (sparse-unique safe), handle stub, connect disabled, isDemo cleared so it
   *     stops appearing in the Demo Manager list (it is no longer a live demo).
   * Then recompute honest counts on real records the demo had engaged with.
   *
   * Mirrors the anonymize-don't-delete stub in account-erasure.service.ts.
   */
  private async stubEntangled(ids: Types.ObjectId[]): Promise<number> {
    if (ids.length === 0) return 0;

    const affected = await this.collectAffected(ids);

    // Delete only the demo's OWN content + own engagement — NOT the shared
    // relationship rows (threads/connections/requests/follows/inquiries/quotes/
    // applications), which a real user is party to.
    const ws = await this.col('workspaces')
      .find({ ownerId: { $in: ids } }, { projection: { _id: 1 } })
      .toArray();
    const wsIds = ws.map((w) => w._id as Types.ObjectId);
    await this.col('attendances').deleteMany({ workspaceId: { $in: wsIds } });
    await this.col('workspacemembers').deleteMany({ workspaceId: { $in: wsIds } });
    await this.col('workspaces').deleteMany({ _id: { $in: wsIds } });
    await this.col('connectprofiles').deleteMany({ userId: { $in: ids } });
    await this.col('connectfeedentries').deleteMany({
      $or: [{ ownerId: { $in: ids } }, { authorId: { $in: ids } }],
    });
    // The demo's own engagement on OTHER (real) posts is still removed so the
    // real post's count stops being demo-inflated; threads/edges between people
    // are preserved (NOT in the delete list below).
    await this.col('connectengagementedges').deleteMany({
      $or: [{ actorId: { $in: ids } }, { authorId: { $in: ids } }],
    });
    await this.col('connectseenposts').deleteMany({ viewerId: { $in: ids } });
    await this.col('connectreactions').deleteMany({ userId: { $in: ids } });
    await this.col('connectcomments').deleteMany({ authorId: { $in: ids } });
    await this.col('connectposts').deleteMany({ authorId: { $in: ids } });
    await this.col('connect_listings').deleteMany({ ownerUserId: { $in: ids } });
    await this.col('connect_storefronts').deleteMany({ ownerUserId: { $in: ids } });
    await this.col('connect_company_pages').deleteMany({ ownerUserId: { $in: ids } });
    // NOTE: connect_quotes / connect_rfqs / connect_job_applications / connect_jobs
    // / connect_inquiries / connect_threads / connect_messages / connectconnections
    // / connectconnectionrequests / connectfollows are KEPT — a real user is the
    // counterparty. Recompute below fixes the real records' tallies after the
    // demo's OWN engagement (reactions/comments above) is stripped.

    // Anonymize the User doc → permanent stub (one $set per account so each gets
    // a unique handle; email/mobile null is sparse-unique-safe).
    for (const id of ids) {
      const hex = id.toString();
      await this.col('users').updateOne(
        { _id: id },
        {
          $set: {
            name: 'Sample account no longer available',
            email: null,
            mobile: null,
            handle: `sample-${hex}`,
            handleChangedAt: null,
            profilePicture: null,
            isActive: false,
            deletedAt: new Date(),
            connectEnabled: false,
            // No longer a live demo account — drop the marker so it leaves the
            // Demo Manager list and is never re-classified/re-purged.
            isDemo: false,
          },
        },
      );
    }

    await this.recomputeAffected(affected.posts, affected.rfqs, affected.jobs);

    return ids.length;
  }

  /**
   * Classify + purge a set of demo ids the SAFE way: CLEAN → hard purge,
   * ENTANGLED → anonymized stub. Returns the split for audit + response.
   */
  private async safePurge(
    ids: Types.ObjectId[],
  ): Promise<{ hardDeleted: number; stubbed: number }> {
    if (ids.length === 0) return { hardDeleted: 0, stubbed: 0 };
    const { clean, entangled } = await this.classify(ids);
    const hardDeleted = await this.purgeClean(clean);
    const stubbed = await this.stubEntangled(entangled);
    return { hardDeleted, stubbed };
  }

  /** Remove ALL demo content (CLEAN hard-purged, ENTANGLED stubbed). */
  async clearAll(
    actorId: string,
  ): Promise<{ removed: number; hardDeleted: number; stubbed: number }> {
    const ids = await this.demoUserIds();
    const { hardDeleted, stubbed } = await this.safePurge(ids);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'connect_demo',
      // AuditService coerces entityId via new Types.ObjectId(...), so a literal
      // like 'all' would throw. Use a synthetic batch id; the real scope is in meta.
      entityId: new Types.ObjectId().toString(),
      action: 'admin_clear_connect_demo',
      actorId,
      meta: { hardDeleted: String(hardDeleted), stubbed: String(stubbed), scope: 'all' },
    });
    return { removed: hardDeleted + stubbed, hardDeleted, stubbed };
  }

  /** Remove ONE demo account (refuses non-demo users; CLEAN purge or stub). */
  async deleteUser(
    id: string,
    actorId: string,
  ): Promise<{ removed: number; hardDeleted: number; stubbed: number }> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Demo account not found');
    const oid = new Types.ObjectId(id);
    const user = await this.col('users').findOne({ _id: oid, $or: DEMO_OR });
    if (!user) throw new NotFoundException('Demo account not found');
    const { hardDeleted, stubbed } = await this.safePurge([oid]);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'connect_demo',
      entityId: id,
      action: 'admin_delete_connect_demo_user',
      actorId,
      meta: {
        name: String((user as { name?: string }).name ?? ''),
        outcome: hardDeleted > 0 ? 'hard_deleted' : 'stubbed',
      },
    });
    return { removed: hardDeleted + stubbed, hardDeleted, stubbed };
  }

  /**
   * Dry-run report — what a `clearAll()` WOULD do, WITHOUT mutating anything.
   * Returns the CLEAN/ENTANGLED split (hard-deleted vs stubbed account counts)
   * and a per-collection count of rows that would be deleted. ENTANGLED accounts
   * contribute only their OWN non-shared content to the delete tallies; their
   * shared relationship rows are reported as KEPT (not counted).
   */
  async dryRun(actorId: string): Promise<DemoPurgeReport> {
    const ids = await this.demoUserIds();
    if (ids.length === 0) {
      await this.audit.logEvent({
        workspaceId: null,
        module: AppModule.CONNECT,
        entityType: 'connect_demo',
        entityId: new Types.ObjectId().toString(),
        action: 'admin_dryrun_connect_demo',
        actorId,
        meta: { demoAccounts: '0', hardDeleted: '0', stubbed: '0' },
      });
      return { demoAccounts: 0, hardDeleted: 0, stubbed: 0, rows: [] };
    }

    const { clean, entangled } = await this.classify(ids);
    const allIds = [...clean, ...entangled];

    // Workspaces owned by ANY demo (both CLEAN + ENTANGLED workspaces are
    // deleted — a workspace is the demo's own asset, not a real-user edge).
    const ws = await this.col('workspaces')
      .find({ ownerId: { $in: allIds } }, { projection: { _id: 1 } })
      .toArray();
    const wsIds = ws.map((w) => w._id as Types.ObjectId);

    // Threads / messages are deleted ONLY for CLEAN accounts (ENTANGLED keep
    // them). Count both threads + their messages for the CLEAN set.
    const cleanThreads =
      clean.length > 0
        ? await this.col('connect_threads')
            .find({ participantIds: { $in: clean } }, { projection: { _id: 1 } })
            .toArray()
        : [];
    const cleanThreadIds = cleanThreads.map((t) => t._id as Types.ObjectId);

    const countIn = (collection: string, filter: Record<string, unknown>) =>
      this.col(collection).countDocuments(filter);

    // Helper for "owned by any demo" content (deleted for BOTH clean+entangled).
    const ownedFilter = (field: string) => ({ [field]: { $in: allIds } });

    const [
      attendances,
      workspacemembers,
      connectprofiles,
      connectfeedentries,
      connectengagementedges,
      connectseenposts,
      connectreactions,
      connectcomments,
      connectposts,
      listings,
      storefronts,
      companyPages,
      // CLEAN-only relationship rows:
      connectconnections,
      connectconnectionrequests,
      connectfollows,
      quotes,
      rfqs,
      jobApplications,
      jobs,
      inquiries,
      threadMessages,
    ] = await Promise.all([
      countIn('attendances', { workspaceId: { $in: wsIds } }),
      countIn('workspacemembers', { workspaceId: { $in: wsIds } }),
      countIn('connectprofiles', { userId: { $in: allIds } }),
      countIn('connectfeedentries', {
        $or: [{ ownerId: { $in: allIds } }, { authorId: { $in: allIds } }],
      }),
      countIn('connectengagementedges', {
        $or: [{ actorId: { $in: allIds } }, { authorId: { $in: allIds } }],
      }),
      countIn('connectseenposts', { viewerId: { $in: allIds } }),
      countIn('connectreactions', { userId: { $in: allIds } }),
      countIn('connectcomments', { authorId: { $in: allIds } }),
      countIn('connectposts', ownedFilter('authorId')),
      countIn('connect_listings', ownedFilter('ownerUserId')),
      countIn('connect_storefronts', ownedFilter('ownerUserId')),
      countIn('connect_company_pages', ownedFilter('ownerUserId')),
      // Relationship rows — deleted only for CLEAN accounts.
      clean.length > 0
        ? countIn('connectconnections', {
            $or: [{ userA: { $in: clean } }, { userB: { $in: clean } }],
          })
        : Promise.resolve(0),
      clean.length > 0
        ? countIn('connectconnectionrequests', {
            $or: [{ fromUserId: { $in: clean } }, { toUserId: { $in: clean } }],
          })
        : Promise.resolve(0),
      clean.length > 0
        ? countIn('connectfollows', {
            $or: [{ followerId: { $in: clean } }, { followeeId: { $in: clean } }],
          })
        : Promise.resolve(0),
      clean.length > 0
        ? countIn('connect_quotes', { sellerUserId: { $in: clean } })
        : Promise.resolve(0),
      clean.length > 0
        ? countIn('connect_rfqs', { buyerUserId: { $in: clean } })
        : Promise.resolve(0),
      clean.length > 0
        ? countIn('connect_job_applications', { applicantUserId: { $in: clean } })
        : Promise.resolve(0),
      // Jobs are the demo's OWN asset → deleted for both clean+entangled.
      countIn('connect_jobs', ownedFilter('companyUserId')),
      clean.length > 0
        ? countIn('connect_inquiries', {
            $or: [{ buyerUserId: { $in: clean } }, { sellerUserId: { $in: clean } }],
          })
        : Promise.resolve(0),
      cleanThreadIds.length > 0
        ? countIn('connect_messages', { threadId: { $in: cleanThreadIds } })
        : Promise.resolve(0),
    ]);

    const rows: DemoPurgeReportRow[] = [
      // Only CLEAN users are hard-deleted; ENTANGLED become stubs (updated, not
      // deleted) so they are NOT counted as deleted users.
      { collection: 'users', toDelete: clean.length },
      { collection: 'attendances', toDelete: attendances },
      { collection: 'workspacemembers', toDelete: workspacemembers },
      { collection: 'workspaces', toDelete: wsIds.length },
      { collection: 'connectprofiles', toDelete: connectprofiles },
      { collection: 'connectfeedentries', toDelete: connectfeedentries },
      { collection: 'connectengagementedges', toDelete: connectengagementedges },
      { collection: 'connectseenposts', toDelete: connectseenposts },
      { collection: 'connectreactions', toDelete: connectreactions },
      { collection: 'connectcomments', toDelete: connectcomments },
      { collection: 'connectposts', toDelete: connectposts },
      { collection: 'connect_listings', toDelete: listings },
      { collection: 'connect_storefronts', toDelete: storefronts },
      { collection: 'connect_company_pages', toDelete: companyPages },
      { collection: 'connect_jobs', toDelete: jobs },
      { collection: 'connectconnections', toDelete: connectconnections },
      { collection: 'connectconnectionrequests', toDelete: connectconnectionrequests },
      { collection: 'connectfollows', toDelete: connectfollows },
      { collection: 'connect_quotes', toDelete: quotes },
      { collection: 'connect_rfqs', toDelete: rfqs },
      { collection: 'connect_job_applications', toDelete: jobApplications },
      { collection: 'connect_inquiries', toDelete: inquiries },
      { collection: 'connect_threads', toDelete: cleanThreadIds.length },
      { collection: 'connect_messages', toDelete: threadMessages },
    ];

    const report: DemoPurgeReport = {
      demoAccounts: ids.length,
      hardDeleted: clean.length,
      stubbed: entangled.length,
      rows,
    };

    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'connect_demo',
      entityId: new Types.ObjectId().toString(),
      action: 'admin_dryrun_connect_demo',
      actorId,
      meta: {
        demoAccounts: String(report.demoAccounts),
        hardDeleted: String(report.hardDeleted),
        stubbed: String(report.stubbed),
      },
    });

    return report;
  }

  /** Publish a text feed post AS a demo account (with feed fan-out). */
  async postAs(id: string, body: string, actorId: string): Promise<{ postId: string }> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Demo account not found');
    const oid = new Types.ObjectId(id);
    const user = await this.col('users').findOne({ _id: oid, $or: DEMO_OR });
    if (!user) throw new NotFoundException('Demo account not found');

    const profile = await this.col('connectprofiles').findOne(
      { userId: oid },
      { projection: { skills: 1, district: 1 } },
    );
    const now = new Date();
    const postDoc = {
      authorId: oid,
      companyPageId: null,
      kind: 'text',
      body: body.trim(),
      media: [],
      mediaLayout: 'grid',
      audio: null,
      hashtags: [],
      tags: [],
      visibility: 'public',
      reactionCount: 0,
      commentCount: 0,
      viewCount: 0,
      authorErpLinked: false,
      // This posts AS a demo account, so stamp the demo flag the FE "Sample"
      // badge + feed/search down-rank read (mirrors post.schema default + the
      // seed createPost helper). Without it the post renders with no badge.
      isDemo: true,
      authorSkills: (profile as { skills?: string[] } | null)?.skills ?? [],
      authorDistrict: (profile as { district?: string } | null)?.district ?? '',
      repostOf: null,
      repostCount: 0,
      editedAt: null,
      deletedAt: null,
      boostCampaignId: null,
      createdAt: now,
      updatedAt: now,
    };
    const ins = await this.col('connectposts').insertOne(postDoc);
    const postId = ins.insertedId as Types.ObjectId;

    const follows = await this.col('connectfollows')
      .find({ followeeType: 'user', followeeId: oid }, { projection: { followerId: 1 } })
      .toArray();
    const recipients = [oid, ...follows.map((f) => f.followerId as Types.ObjectId)];
    const seen = new Set<string>();
    const entries = recipients
      .filter((rid) => {
        const k = String(rid);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((rid) => ({
        ownerId: rid,
        postId,
        authorId: oid,
        companyPageId: null,
        postedAt: now,
        createdAt: now,
        updatedAt: now,
      }));
    if (entries.length > 0) await this.col('connectfeedentries').insertMany(entries);

    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'connect_demo_post',
      entityId: String(postId),
      action: 'admin_post_as_connect_demo',
      actorId,
      meta: { authorId: id },
    });
    return { postId: String(postId) };
  }
}
