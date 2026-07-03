/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * ConnectContentPurgeService — the Day-30 Connect content purge
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3A / §10).
 *
 * Runs against a real in-memory MongoDB so the manifest-driven engine is
 * exercised exactly as in production (raw-collection deletes / updates / pulls /
 * aggregate recomputes). Covers the plan's TDD checklist for Phase 3:
 *   - POSITIVE LEAK TEST: after the purge, NO document in any mutating collection
 *     resolves to the erased user's name / email / handle / mobile.
 *   - per-class action correctness incl. counterpart-aggregate recompute;
 *   - "only THIS user's rows are mutated" (other users untouched);
 *   - scope isolation (only Connect collections; a non-Connect collection is
 *     never touched).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  type TestMongo,
} from '../../../../test-utils/mongo-memory';
import { ConnectContentPurgeService } from '../connect-content-purge.service';
import { CONNECT_PURGE_MANIFEST } from '../connect-purge-manifest';

const oid = () => new Types.ObjectId();

describe('ConnectContentPurgeService (Day-30 Connect content purge)', () => {
  let mongo: TestMongo;
  let emitter: { emit: ReturnType<typeof vi.fn> };
  let svc: ConnectContentPurgeService;

  // The user being deleted, plus two bystanders whose data must be untouched.
  const A = oid(); // the deleting user
  const B = oid(); // a counterpart (owns posts/rfqs/jobs the user interacted with)
  const C = oid(); // another bystander

  const col = (name: string) => mongo.connection.db.collection(name);

  beforeAll(async () => {
    mongo = await createTestMongoose();
  }, 60_000);

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);
    emitter = { emit: vi.fn() };
    svc = new ConnectContentPurgeService(mongo.connection as any, emitter as any);
  });

  // ── POSITIVE LEAK TEST (§A.12) ──────────────────────────────────────────────

  it('leaves NO identity residue: after purge no mutating collection resolves to the user', async () => {
    const NAME = 'Zztest LeakName';
    const EMAIL = 'zz-leak@test.example';
    const HANDLE = 'zz-leak-handle';
    const MOBILE = '919900000001';

    // Identity snapshots that live INSIDE Connect rows the user owns / received.
    await col('connect_job_applications').insertOne({
      jobId: oid(),
      applicantUserId: A,
      resumeName: NAME, // a snapshot that could otherwise survive the User scrub
      message: 'hi',
    });
    await col('connect_page_invites').insertOne({
      companyPageId: oid(),
      createdByUserId: B,
      claimedUserId: A,
      inviteeMobile: MOBILE, // the user's own mobile, snapshotted on a claimed invite
      status: 'claimed',
    });
    // The user's own profile + a handful of own-content rows.
    await col('connectprofiles').insertOne({ userId: A, headline: `${HANDLE} ${EMAIL}` });
    await col('connect_listings').insertOne({ ownerUserId: A, title: NAME });
    await col('connectposts').insertOne({
      authorId: A,
      text: EMAIL,
      reactionCount: 0,
      commentCount: 0,
    });
    // A RETAINED billing snapshot (documented §3A(d) carve-out — de-identified at
    // the statutory window, not on the Connect purge).
    await col('connect_referrals').insertOne({
      referrerUserId: B,
      refereeUserId: A,
      signupContext: { refereeMobileSnapshot: MOBILE, refereeEmailSnapshot: EMAIL },
    });

    await svc.purgeUserConnectContent(A.toString());

    const tokens = [NAME, EMAIL, HANDLE, MOBILE];
    const retained = new Set(
      CONNECT_PURGE_MANIFEST.filter(
        (e) => e.klass === 'evidence' || e.klass === 'billing' || e.klass === 'config',
      ).map((e) => e.collection),
    );

    // Every MUTATING collection must be free of the identity tokens.
    for (const entry of CONNECT_PURGE_MANIFEST) {
      if (retained.has(entry.collection)) continue;
      const docs = await col(entry.collection).find({}).toArray();
      const blob = JSON.stringify(docs);
      for (const t of tokens) {
        expect(blob.includes(t), `${entry.collection} still leaks "${t}"`).toBe(false);
      }
    }

    // The documented carve-out is retained on purpose (proves we don't over-delete
    // billing/fraud evidence; it is de-identified at the Phase-7 statutory window).
    const ref = await col('connect_referrals').findOne({ refereeUserId: A });
    expect(ref).not.toBeNull();
    expect(JSON.stringify(ref).includes(MOBILE)).toBe(true);
  });

  // ── (a) own content — hard delete, only this user ───────────────────────────

  it('(a) hard-deletes the user own content and leaves other users untouched', async () => {
    await col('connectsavedposts').insertMany([
      { userId: A, postId: oid() },
      { userId: A, postId: oid() },
      { userId: B, postId: oid() },
    ]);
    await col('connect_over_limit_states').insertMany([
      { userId: A, kind: 'lead' },
      { userId: C, kind: 'lead' },
    ]);

    await svc.purgeUserConnectContent(A.toString());

    expect(await col('connectsavedposts').countDocuments({ userId: A })).toBe(0);
    expect(await col('connectsavedposts').countDocuments({ userId: B })).toBe(1);
    expect(await col('connect_over_limit_states').countDocuments({ userId: A })).toBe(0);
    expect(await col('connect_over_limit_states').countDocuments({ userId: C })).toBe(1);
  });

  // ── (b-out) outbound — delete both directions, keep unrelated edges ──────────

  it('(b-out) deletes connection edges touching the user, keeps unrelated edges', async () => {
    await col('connectconnections').insertMany([
      { userA: A, userB: B },
      { userA: B, userB: C }, // unrelated to A
    ]);
    await col('connectfollows').insertMany([
      { followerId: A, followeeType: 'user', followeeId: B },
      { followerId: C, followeeType: 'user', followeeId: A }, // someone follows A
      { followerId: C, followeeType: 'user', followeeId: B }, // unrelated
    ]);

    await svc.purgeUserConnectContent(A.toString());

    expect(await col('connectconnections').countDocuments({})).toBe(1);
    expect(await col('connectconnections').countDocuments({ userA: B, userB: C })).toBe(1);
    expect(await col('connectfollows').countDocuments({})).toBe(1);
    expect(await col('connectfollows').countDocuments({ followerId: C, followeeId: B })).toBe(1);
  });

  it('(b-out) only deletes a polymorphic followeeId when it really references a User', async () => {
    const pageId = oid();
    // A page-follow whose followeeId happens to collide is impossible, but a row
    // where followeeId === A only with followeeType 'companyPage' must NOT match.
    await col('connectfollows').insertMany([
      { followerId: C, followeeType: 'companyPage', followeeId: A }, // A is a page id here, not a user
    ]);

    await svc.purgeUserConnectContent(A.toString());

    // followeeId===A but type is companyPage → NOT a user reference → retained.
    expect(await col('connectfollows').countDocuments({})).toBe(1);
    void pageId;
  });

  // ── (c) recompute — reactions ───────────────────────────────────────────────

  it('(c) deletes the user reactions and decrements each counterpart post reactionCount', async () => {
    const post = oid();
    await col('connectposts').insertOne({
      _id: post,
      authorId: B,
      reactionCount: 2,
      commentCount: 0,
    });
    await col('connectreactions').insertMany([
      { postId: post, userId: A },
      { postId: post, userId: C },
    ]);

    await svc.purgeUserConnectContent(A.toString());

    expect(await col('connectreactions').countDocuments({ userId: A })).toBe(0);
    expect(await col('connectreactions').countDocuments({ userId: C })).toBe(1);
    const fresh = await col('connectposts').findOne({ _id: post });
    expect(fresh.reactionCount).toBe(1);
  });

  // ── (c) recompute — comments (count clamps, multi per post) ──────────────────

  it('(c) deletes the user comments and decrements counterpart post commentCount by the live count', async () => {
    const post = oid();
    await col('connectposts').insertOne({
      _id: post,
      authorId: B,
      reactionCount: 0,
      commentCount: 3,
    });
    await col('connectcomments').insertMany([
      { postId: post, authorId: A, deletedAt: null },
      { postId: post, authorId: A, deletedAt: null },
      { postId: post, authorId: C, deletedAt: null },
    ]);

    await svc.purgeUserConnectContent(A.toString());

    expect(await col('connectcomments').countDocuments({ authorId: A })).toBe(0);
    expect(await col('connectcomments').countDocuments({ authorId: C })).toBe(1);
    const fresh = await col('connectposts').findOne({ _id: post });
    expect(fresh.commentCount).toBe(1); // 3 - 2 (A's live comments)
  });

  // ── (c) recompute — reviews (Wilson aggregate) ──────────────────────────────

  it('(c) deletes the reviews the user wrote and recomputes each subject SellerRating', async () => {
    // Subject B rated by A (5) and C (3). Aggregate before: count 2, avg 4.
    await col('connect_reviews').insertMany([
      { reviewerUserId: A, subjectUserId: B, rating: 5, status: 'active' },
      { reviewerUserId: C, subjectUserId: B, rating: 3, status: 'active' },
    ]);
    await col('connect_seller_ratings').insertOne({
      subjectUserId: B,
      ratingCount: 2,
      ratingAvg: 4,
      positiveCount: 1,
      wilsonScore: 0.1,
    });
    // A review ABOUT the user (subjectUserId = A) authored by C is retained.
    await col('connect_reviews').insertOne({
      reviewerUserId: C,
      subjectUserId: A,
      rating: 4,
      status: 'active',
    });

    await svc.purgeUserConnectContent(A.toString());

    expect(await col('connect_reviews').countDocuments({ reviewerUserId: A })).toBe(0);
    // The review ABOUT the user is retained (b-about third-party evidence).
    expect(await col('connect_reviews').countDocuments({ subjectUserId: A })).toBe(1);
    const rating = await col('connect_seller_ratings').findOne({ subjectUserId: B });
    expect(rating.ratingCount).toBe(1);
    expect(rating.ratingAvg).toBe(3);
  });

  // ── (c) recompute — quotes (RFQ aggregates) ─────────────────────────────────

  it('(c) deletes the seller quotes and recomputes the counterpart RFQ aggregates', async () => {
    const rfq = oid();
    await col('connect_rfqs').insertOne({
      _id: rfq,
      buyerUserId: B,
      quotesCount: 2,
      lowestQuotePrice: 100,
    });
    await col('connect_quotes').insertMany([
      { rfqId: rfq, sellerUserId: A, price: 100, status: 'sent', isDemo: false },
      { rfqId: rfq, sellerUserId: C, price: 200, status: 'sent', isDemo: false },
    ]);

    await svc.purgeUserConnectContent(A.toString());

    expect(await col('connect_quotes').countDocuments({ sellerUserId: A })).toBe(0);
    const fresh = await col('connect_rfqs').findOne({ _id: rfq });
    expect(fresh.quotesCount).toBe(1);
    expect(fresh.lowestQuotePrice).toBe(200);
  });

  // ── (b-msg) null the sender FK, retain the message + thread ──────────────────

  it('(b-msg) nulls the message senderUserId + pulls seenBy, retaining the message body', async () => {
    const thread = oid();
    await col('connect_threads').insertOne({ _id: thread, participantIds: [A, B], pairKey: 'x' });
    await col('connect_messages').insertOne({
      threadId: thread,
      senderUserId: A,
      seenBy: [A, B],
      body: 'a retained message body',
    });

    await svc.purgeUserConnectContent(A.toString());

    const msg = await col('connect_messages').findOne({ threadId: thread });
    expect(msg).not.toBeNull();
    expect(msg.senderUserId).toBeNull();
    expect(msg.body).toBe('a retained message body'); // retained like a sent email
    expect((msg.seenBy as Types.ObjectId[]).map(String)).toEqual([B.toString()]);
    // The thread (shared multi-party record) is retained.
    expect(await col('connect_threads').countDocuments({ _id: thread })).toBe(1);
  });

  // ── (b-out) pull the embedded recommendation the user authored ──────────────

  it('(b-out) pulls the recommendation the user wrote from OTHER profiles, keeps others', async () => {
    await col('connectprofiles').insertOne({
      userId: B,
      recommendations: [
        { fromUserId: A, text: 'A wrote this' },
        { fromUserId: C, text: 'C wrote this' },
      ],
    });

    await svc.purgeUserConnectContent(A.toString());

    const prof = await col('connectprofiles').findOne({ userId: B });
    expect(prof.recommendations).toHaveLength(1);
    expect(String((prof.recommendations as any[])[0].fromUserId)).toBe(C.toString());
  });

  // ── (d)/(e) retain billing, pull the user from an admin-campaign array ───────

  it('(d/e) retains referral evidence and pulls the user from a credit-drop recipient array', async () => {
    await col('connect_referrals').insertOne({ referrerUserId: B, refereeUserId: A });
    await col('connect_credit_drops').insertOne({ createdBy: B, targetUserIds: [A, C] });
    await col('ad_wallet_ledgers').insertOne({ ownerUserId: A, amountPaise: 500, type: 'topup' });

    await svc.purgeUserConnectContent(A.toString());

    // Referral + ad money trail retained (Bucket-B/D evidence).
    expect(await col('connect_referrals').countDocuments({ refereeUserId: A })).toBe(1);
    expect(await col('ad_wallet_ledgers').countDocuments({ ownerUserId: A })).toBe(1);
    // The user is pulled from the admin credit-drop recipient list; the drop stays.
    const drop = await col('connect_credit_drops').findOne({ createdBy: B });
    expect((drop.targetUserIds as Types.ObjectId[]).map(String)).toEqual([C.toString()]);
  });

  // ── (f) de-index events fire for deleted entities ───────────────────────────

  it('(f) emits search de-index events for the deleted listings / jobs / profile', async () => {
    await col('connectprofiles').insertOne({ userId: A });
    await col('connect_listings').insertOne({ ownerUserId: A, title: 'x' });
    await col('connect_jobs').insertOne({ companyUserId: A, title: 'y' });

    await svc.purgeUserConnectContent(A.toString());

    const events = emitter.emit.mock.calls.map((c) => c[0]);
    expect(events).toContain('connect.profile.changed');
    expect(events).toContain('connect.listing.changed');
    expect(events).toContain('connect.job.changed');
  });

  // ── scope isolation — only Connect collections, only this user ──────────────

  it('never touches a non-Connect collection', async () => {
    await col('users').insertOne({ _id: A, name: 'Real Name', email: 'real@x.com' });
    await col('salaries').insertOne({ teamMemberId: A, amountPaise: 1000 });

    await svc.purgeUserConnectContent(A.toString());

    expect(await col('users').countDocuments({ _id: A })).toBe(1);
    expect(await col('salaries').countDocuments({ teamMemberId: A })).toBe(1);
  });

  it('returns a summary and is fault-isolated per collection', async () => {
    await col('connectsavedposts').insertOne({ userId: A, postId: oid() });
    const summary = await svc.purgeUserConnectContent(A.toString());
    expect(summary.userId).toBe(A.toString());
    expect(summary.collectionsProcessed).toBe(CONNECT_PURGE_MANIFEST.length);
    expect(summary.rowsDeleted).toBeGreaterThanOrEqual(1);
    expect(summary.failures).toEqual([]);
  });

  // ── CN-PURGE-1 (Bucket 2) — 'ads-purge' handler: forfeit, not refund ────────
  //
  // QA (Stage 5): the security review's exact "delete an account with an active
  // post boost" scenario, run through the REAL entry point (purgeUserConnectContent)
  // against real ad_campaigns / ad_advertiser_wallets / ad_wallet_ledgers documents
  // — not just the isolated WalletService/BoostService unit tests. Confirms the
  // manifest's `handler:'ads-purge'` wiring (connect-purge-manifest.ts:531) is
  // actually invoked end-to-end and produces the forfeit (not refund) outcome.

  it("ads-purge: forfeits an active boost campaign's unspent reserve with NO wallet credit, marks it completed", async () => {
    const campaign = oid();
    await col('ad_campaigns').insertOne({
      _id: campaign,
      ownerUserId: A,
      status: 'active',
      totalBudget: 500,
      budgetSpent: 100, // 400 unspent
      reservedFromGrant: 240,
      reservedFromBalance: 160,
    });
    await col('ad_advertiser_wallets').insertOne({
      ownerUserId: A,
      balance: 1000,
      grantBalance: 300,
      reserved: 400, // exactly the campaign's unspent hold
    });

    const summary = await svc.purgeUserConnectContent(A.toString());
    expect(summary.failures).toEqual([]);

    // Campaign: completed + reads fully-spent, no leftover budget on its own numbers.
    const freshCampaign = await col('ad_campaigns').findOne({ _id: campaign });
    expect(freshCampaign.status).toBe('completed');
    expect(freshCampaign.budgetSpent).toBe(500); // bumped to totalBudget
    expect(freshCampaign.reservedFromGrant).toBe(0);
    expect(freshCampaign.reservedFromBalance).toBe(0);

    // Wallet: balance + grantBalance UNCHANGED (forfeit, not refund); reserved
    // decremented by exactly the unspent amount (400).
    const freshWallet = await col('ad_advertiser_wallets').findOne({ ownerUserId: A });
    expect(freshWallet.balance).toBe(1000);
    expect(freshWallet.grantBalance).toBe(300);
    expect(freshWallet.reserved).toBe(0);

    // Exactly one 'forfeit'-type ledger row for this campaign.
    const forfeitRows = await col('ad_wallet_ledgers')
      .find({ ownerUserId: A, type: 'forfeit' })
      .toArray();
    expect(forfeitRows).toHaveLength(1);
    expect(forfeitRows[0].amount).toBe(-400);
    expect(forfeitRows[0].reservedAfter).toBe(0);
    expect(forfeitRows[0].balanceAfter).toBe(1000);
    expect(String(forfeitRows[0].campaignId)).toBe(String(campaign));
  });

  it('ads-purge: running the purge a second time on an already-purged campaign is a no-op (no double-decrement, no 2nd ledger row)', async () => {
    const campaign = oid();
    await col('ad_campaigns').insertOne({
      _id: campaign,
      ownerUserId: A,
      status: 'active',
      totalBudget: 500,
      budgetSpent: 100,
      reservedFromGrant: 240,
      reservedFromBalance: 160,
    });
    await col('ad_advertiser_wallets').insertOne({
      ownerUserId: A,
      balance: 1000,
      grantBalance: 300,
      reserved: 400,
    });

    await svc.purgeUserConnectContent(A.toString());
    // Re-run against the SAME (already-purged) state — simulates a retried purge
    // job or a redundant cron tick hitting the same account.
    const secondSummary = await svc.purgeUserConnectContent(A.toString());
    expect(secondSummary.failures).toEqual([]);

    // Wallet reserved is NOT decremented a second time (would go negative if it were).
    const freshWallet = await col('ad_advertiser_wallets').findOne({ ownerUserId: A });
    expect(freshWallet.reserved).toBe(0);
    expect(freshWallet.balance).toBe(1000);
    expect(freshWallet.grantBalance).toBe(300);

    // Still exactly ONE forfeit ledger row total (the second run's status-filter
    // excludes the now-completed campaign, so purgeAdsForUser never re-processes it).
    const forfeitRows = await col('ad_wallet_ledgers')
      .find({ ownerUserId: A, type: 'forfeit' })
      .toArray();
    expect(forfeitRows).toHaveLength(1);
  });

  it("ads-purge: a campaign that already finished (status:'completed') before the purge is left untouched (no re-forfeit, no ledger row)", async () => {
    const campaign = oid();
    await col('ad_campaigns').insertOne({
      _id: campaign,
      ownerUserId: A,
      status: 'completed', // ordinary cancel/pause already released its reserve
      totalBudget: 500,
      budgetSpent: 500,
      reservedFromGrant: 0,
      reservedFromBalance: 0,
    });
    await col('ad_advertiser_wallets').insertOne({
      ownerUserId: A,
      balance: 1000,
      grantBalance: 0,
      reserved: 0,
    });

    await svc.purgeUserConnectContent(A.toString());

    const freshWallet = await col('ad_advertiser_wallets').findOne({ ownerUserId: A });
    expect(freshWallet.reserved).toBe(0);
    expect(freshWallet.balance).toBe(1000); // untouched
    const forfeitRows = await col('ad_wallet_ledgers')
      .find({ ownerUserId: A, type: 'forfeit' })
      .toArray();
    expect(forfeitRows).toHaveLength(0); // never processed — already terminal
  });

  it("ads-purge: leaves a bystander's (other user's) active campaign + wallet completely untouched", async () => {
    const campaignA = oid();
    const campaignB = oid();
    await col('ad_campaigns').insertMany([
      {
        _id: campaignA,
        ownerUserId: A,
        status: 'active',
        totalBudget: 200,
        budgetSpent: 0,
        reservedFromGrant: 0,
        reservedFromBalance: 200,
      },
      {
        _id: campaignB,
        ownerUserId: B, // bystander — must be untouched by A's purge
        status: 'active',
        totalBudget: 300,
        budgetSpent: 0,
        reservedFromGrant: 0,
        reservedFromBalance: 300,
      },
    ]);
    await col('ad_advertiser_wallets').insertMany([
      { ownerUserId: A, balance: 500, grantBalance: 0, reserved: 200 },
      { ownerUserId: B, balance: 700, grantBalance: 0, reserved: 300 },
    ]);

    await svc.purgeUserConnectContent(A.toString());

    // A's campaign forfeited + completed.
    const freshA = await col('ad_campaigns').findOne({ _id: campaignA });
    expect(freshA.status).toBe('completed');

    // B's campaign + wallet are completely unaffected — cross-workspace/user
    // isolation for the money path (mirrors the module's standard isolation check).
    const freshB = await col('ad_campaigns').findOne({ _id: campaignB });
    expect(freshB.status).toBe('active');
    expect(freshB.budgetSpent).toBe(0);
    const walletB = await col('ad_advertiser_wallets').findOne({ ownerUserId: B });
    expect(walletB.balance).toBe(700);
    expect(walletB.reserved).toBe(300);
    const forfeitRowsB = await col('ad_wallet_ledgers')
      .find({ ownerUserId: B, type: 'forfeit' })
      .toArray();
    expect(forfeitRowsB).toHaveLength(0);
  });

  it('ads-purge: a fully-drafted campaign with no reserve (pending_review, nothing spent or reserved) completes cleanly with no wallet write', async () => {
    const campaign = oid();
    await col('ad_campaigns').insertOne({
      _id: campaign,
      ownerUserId: A,
      status: 'pending_review',
      totalBudget: 100,
      budgetSpent: 0,
      reservedFromGrant: 0,
      reservedFromBalance: 0, // never actually reserved (e.g. rejected before funding)
    });
    // No wallet row at all for A — must not throw or fabricate one.

    const summary = await svc.purgeUserConnectContent(A.toString());
    expect(summary.failures).toEqual([]);

    const fresh = await col('ad_campaigns').findOne({ _id: campaign });
    expect(fresh.status).toBe('completed');
    expect(fresh.budgetSpent).toBe(100); // still bumped to totalBudget for consistency

    const forfeitRows = await col('ad_wallet_ledgers')
      .find({ ownerUserId: A, type: 'forfeit' })
      .toArray();
    expect(forfeitRows).toHaveLength(0); // unspent was 0 -> nothing to forfeit
  });
});
