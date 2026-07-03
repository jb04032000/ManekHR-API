/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * BoostService post-boost unit tests -- strict TDD.
 *
 * Covers the post-boost create path + the stop-on-delete/unpublish hook that
 * mirrors the listing/job boost flows. A post boost is a `boost_post` campaign
 * with a `promoted_post` creative bound to the LIVE `feed_promoted_post`
 * placement (the same slot the feed page already serves + the FE already
 * renders/tracks), so once approved it serves through the existing path.
 *
 * Links to: ad-decision.service (auction reads the feed_promoted_post slot),
 * feed.service.editPost/deletePost (emit connect.post.changed -> onPostChanged
 * stops the campaign). All models/wallet are in-process fakes; no DB.
 */

vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { BoostService } from '../boost.service';
import type { CreatePostBoostInput, RollupReader } from '../boost.service';

function makeId(): string {
  return new Types.ObjectId().toHexString();
}

const OWNER = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';

/**
 * Campaign fake: holds both campaigns created via `create()` AND any seeded
 * campaign (for the stop path, where a campaign already exists). `findById`
 * resolves from either store so stopForPost can locate the linked campaign.
 */
function createFakeCampaignModel(seeded?: Record<string, any>) {
  const created: any[] = [];
  const store = new Map<string, any>();
  if (seeded) store.set(String(seeded._id), seeded);
  return {
    _created: created,
    _store: store,
    create(data: Record<string, any>) {
      const save = vi.fn().mockResolvedValue(undefined);
      const doc = { _id: makeId(), save, ...data };
      created.push(doc);
      store.set(String(doc._id), doc);
      return Promise.resolve(doc);
    },
    findById(id: string) {
      return Promise.resolve(store.get(String(id)) ?? null);
    },
    updateOne(_filter: Record<string, any>, _update: Record<string, any>) {
      return Promise.resolve({ modifiedCount: 1 });
    },
    deleteOne(filter: Record<string, any>) {
      store.delete(String(filter._id));
      return Promise.resolve({ deletedCount: 1 });
    },
  };
}

function createFakeAdSetModel() {
  const created: any[] = [];
  return {
    _created: created,
    create(data: Record<string, any>) {
      const doc = { _id: makeId(), ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },
    deleteOne() {
      return Promise.resolve({ deletedCount: 1 });
    },
  };
}

function createFakeCreativeModel() {
  const created: any[] = [];
  return {
    _created: created,
    create(data: Record<string, any>) {
      const doc = { _id: makeId(), ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },
    deleteOne() {
      return Promise.resolve({ deletedCount: 1 });
    },
  };
}

function createFakeWallet(reserveResult = true) {
  return {
    reserve: vi.fn().mockResolvedValue(reserveResult),
    // CN-ADS-1 (feed harden): create now reserves via reserveDetailed (returns
    // the grant/purchased split). No tracked split -> all from purchased balance.
    reserveDetailed: vi.fn().mockImplementation((_o: string, amount: number) =>
      Promise.resolve({
        ok: reserveResult,
        fromGrant: 0,
        fromBalance: reserveResult ? amount : 0,
      }),
    ),
    release: vi.fn().mockResolvedValue(undefined),
    forfeitReserve: vi.fn().mockResolvedValue(undefined),
  };
}

function createFakeRollups(): RollupReader {
  return {
    aggregateFor: vi.fn().mockResolvedValue({
      impressions: 0,
      viewableImpressions: 0,
      clicks: 0,
      validClicks: 0,
      spend: 0,
    }),
  };
}

function makePostDoc(overrides: Record<string, any> = {}) {
  return {
    _id: makeId(),
    authorId: new Types.ObjectId(OWNER),
    visibility: 'public',
    deletedAt: null as Date | null,
    boostCampaignId: null as any,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createFakePostModel(seed: ReturnType<typeof makePostDoc> | null) {
  return {
    findById(id: string) {
      if (seed && String(seed._id) === String(id)) return Promise.resolve(seed);
      return Promise.resolve(null);
    },
  };
}

const BASE: Omit<CreatePostBoostInput, 'postId'> = {
  ownerUserId: OWNER,
  objective: 'reach',
  totalBudget: 500,
  days: 7,
  targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
};

function buildService(opts: {
  post: ReturnType<typeof makePostDoc> | null;
  reserve?: boolean;
  seededCampaign?: Record<string, any>;
  posthog?: { capture: ReturnType<typeof vi.fn> };
  noPostModel?: boolean;
}) {
  const campaignModel = createFakeCampaignModel(opts.seededCampaign);
  const adSetModel = createFakeAdSetModel();
  const creativeModel = createFakeCreativeModel();
  const wallet = createFakeWallet(opts.reserve ?? true);
  const postModel = opts.noPostModel ? undefined : createFakePostModel(opts.post);

  // Positional construction: listingModel(7)/jobModel(8)/rollupModel(9) are
  // undefined here (post path needs none); postModel is the last param (10).
  const svc = new BoostService(
    campaignModel as any,
    adSetModel as any,
    creativeModel as any,
    wallet as any,
    createFakeRollups(),
    opts.posthog as any,
    undefined,
    undefined,
    undefined,
    postModel as any,
  );

  return { svc, campaignModel, adSetModel, creativeModel, wallet };
}

describe('BoostService.createPostBoost', () => {
  it('public + owned post: creates boost_post + promoted_post on feed_promoted_post, reserves, links boostCampaignId', async () => {
    const post = makePostDoc();
    const { svc, adSetModel, creativeModel, wallet } = buildService({ post });

    const result = await svc.createPostBoost({ ...BASE, postId: String(post._id) });

    expect(result.kind).toBe('boost_post');
    expect(result.billingEvent).toBe('cpm');
    expect(result.bid).toBe(40);
    // Publish-then-moderate: a launched boost serves immediately (active).
    expect(result.status).toBe('active');
    expect(String(result.sourcePostId)).toBe(String(post._id));

    expect(adSetModel._created[0].placements).toEqual(['feed_sponsored']);

    const creative = creativeModel._created[0];
    expect(creative.kind).toBe('promoted_post');
    expect(String(creative.postRef)).toBe(String(post._id));
    // Publish-then-moderate: the creative is approved on create so it serves.
    expect(creative.reviewStatus).toBe('approved');
    expect(creative.listingRef).toBeUndefined();

    expect(wallet.reserveDetailed).toHaveBeenCalledWith(OWNER, 500, String(result._id));
    expect(String(post.boostCampaignId)).toBe(String(result._id));
    expect(post.save).toHaveBeenCalled();
  });

  it('profile_visits objective: billingEvent cpc, bid 4', async () => {
    const post = makePostDoc();
    const { svc } = buildService({ post });
    const result = await svc.createPostBoost({
      ...BASE,
      postId: String(post._id),
      objective: 'profile_visits',
    });
    expect(result.billingEvent).toBe('cpc');
    expect(result.bid).toBe(4);
  });

  it('missing post: throws NotFoundException', async () => {
    const { svc } = buildService({ post: null });
    await expect(svc.createPostBoost({ ...BASE, postId: makeId() })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('post authored by another user: throws NotFoundException (only the author can boost, no leak)', async () => {
    const post = makePostDoc({ authorId: new Types.ObjectId(OTHER) });
    const { svc, adSetModel } = buildService({ post });
    await expect(svc.createPostBoost({ ...BASE, postId: String(post._id) })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(adSetModel._created).toHaveLength(0);
  });

  it('non-public (connections) post: throws BadRequestException (audit #9)', async () => {
    const post = makePostDoc({ visibility: 'connections' });
    const { svc, adSetModel } = buildService({ post });
    await expect(svc.createPostBoost({ ...BASE, postId: String(post._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(adSetModel._created).toHaveLength(0);
  });

  it('soft-deleted post: throws BadRequestException', async () => {
    const post = makePostDoc({ deletedAt: new Date() });
    const { svc } = buildService({ post });
    await expect(svc.createPostBoost({ ...BASE, postId: String(post._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('post already in an active boost: throws BadRequestException (no double-boost)', async () => {
    const existing = { _id: makeId(), status: 'active' };
    const post = makePostDoc({ boostCampaignId: existing._id });
    const { svc } = buildService({ post, seededCampaign: existing });
    await expect(svc.createPostBoost({ ...BASE, postId: String(post._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('post whose prior boost is completed: allowed, relinks to the new campaign', async () => {
    const prior = { _id: makeId(), status: 'completed' };
    const post = makePostDoc({ boostCampaignId: prior._id });
    const { svc } = buildService({ post, seededCampaign: prior });
    const result = await svc.createPostBoost({ ...BASE, postId: String(post._id) });
    expect(result.kind).toBe('boost_post');
    expect(String(post.boostCampaignId)).toBe(String(result._id));
  });

  it('wallet reserve fails: BadRequestException, post NOT linked', async () => {
    const post = makePostDoc();
    const { svc } = buildService({ post, reserve: false });
    await expect(svc.createPostBoost({ ...BASE, postId: String(post._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(post.boostCampaignId).toBeNull();
    expect(post.save).not.toHaveBeenCalled();
  });

  it('emits ads.boost_created with target=post when posthog is provided', async () => {
    const post = makePostDoc();
    const posthog = { capture: vi.fn() };
    const { svc } = buildService({ post, posthog });
    const result = await svc.createPostBoost({ ...BASE, postId: String(post._id) });
    expect(posthog.capture).toHaveBeenCalledOnce();
    const call = posthog.capture.mock.calls[0][0];
    expect(call.event).toBe('ads.boost_created');
    expect(call.properties.target).toBe('post');
    expect(call.properties.postId).toBe(String(post._id));
    expect(call.properties.campaignId).toBe(String(result._id));
  });

  it('throws a clear error when the Post model is not injected', async () => {
    const { svc } = buildService({ post: null, noPostModel: true });
    await expect(svc.createPostBoost({ ...BASE, postId: makeId() })).rejects.toThrow(/postModel/);
  });
});

describe('BoostService.stopForPost (early stop on delete / unpublish)', () => {
  it('soft-deleted boosted post: releases unspent budget and completes the campaign', async () => {
    const campaign = {
      _id: makeId(),
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'active',
      totalBudget: 500,
      budgetSpent: 120,
      save: vi.fn().mockResolvedValue(undefined),
    };
    const post = makePostDoc({ deletedAt: new Date(), boostCampaignId: campaign._id });
    const { svc, wallet } = buildService({ post, seededCampaign: campaign });

    await svc.stopForPost(String(post._id));

    expect(wallet.release).toHaveBeenCalledWith(OWNER, 380, String(campaign._id), {
      fromGrant: 0,
      fromBalance: 380,
    });
    expect(campaign.status).toBe('completed');
    expect(campaign.save).toHaveBeenCalled();
  });

  it('post made non-public (connections): stops the campaign', async () => {
    const campaign = {
      _id: makeId(),
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'active',
      totalBudget: 300,
      budgetSpent: 0,
      save: vi.fn().mockResolvedValue(undefined),
    };
    const post = makePostDoc({ visibility: 'connections', boostCampaignId: campaign._id });
    const { svc, wallet } = buildService({ post, seededCampaign: campaign });

    await svc.stopForPost(String(post._id));

    expect(wallet.release).toHaveBeenCalledWith(OWNER, 300, String(campaign._id), {
      fromGrant: 0,
      fromBalance: 300,
    });
    expect(campaign.status).toBe('completed');
  });

  it('still-public live post: no-op (does not stop the campaign)', async () => {
    const campaign = {
      _id: makeId(),
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'active',
      totalBudget: 300,
      budgetSpent: 0,
      save: vi.fn().mockResolvedValue(undefined),
    };
    const post = makePostDoc({ boostCampaignId: campaign._id });
    const { svc, wallet } = buildService({ post, seededCampaign: campaign });

    await svc.stopForPost(String(post._id));

    expect(wallet.release).not.toHaveBeenCalled();
    expect(campaign.status).toBe('active');
  });

  it('post with no boost: no-op', async () => {
    const post = makePostDoc({ deletedAt: new Date(), boostCampaignId: null });
    const { svc, wallet } = buildService({ post });
    await svc.stopForPost(String(post._id));
    expect(wallet.release).not.toHaveBeenCalled();
  });
});

describe('BoostService.onPostChanged (connect.post.changed listener)', () => {
  it("change=deleted: stops the boosted post's campaign", async () => {
    const campaign = {
      _id: makeId(),
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'active',
      totalBudget: 500,
      budgetSpent: 0,
      save: vi.fn().mockResolvedValue(undefined),
    };
    const post = makePostDoc({ deletedAt: new Date(), boostCampaignId: campaign._id });
    const { svc, wallet } = buildService({ post, seededCampaign: campaign });

    await svc.onPostChanged({ postId: String(post._id), change: 'deleted' });

    expect(wallet.release).toHaveBeenCalled();
    expect(campaign.status).toBe('completed');
  });

  it('change=created: never touches a campaign', async () => {
    const post = makePostDoc();
    const { svc, wallet } = buildService({ post });
    await svc.onPostChanged({ postId: String(post._id), change: 'created' });
    expect(wallet.release).not.toHaveBeenCalled();
  });
});
