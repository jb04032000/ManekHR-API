/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema imports do not trip vitest's reflect-metadata.
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

import { Types } from 'mongoose';
import { BoostNudgeService } from '../boost-nudge.service';
import { NUDGE_VIEW_THRESHOLDS } from '../boost-nudge.constants';

const OWNER = new Types.ObjectId().toHexString();

/** A chainable mongoose-query mock that resolves `data` from `.exec()`. */
function q(data: any) {
  const o: any = {};
  for (const m of ['find', 'findOne', 'select', 'sort', 'limit', 'lean']) o[m] = () => o;
  o.exec = () => Promise.resolve(data);
  return o;
}
/** An aggregate() mock that resolves `data` from `.exec()`. */
function agg(data: any) {
  return { exec: () => Promise.resolve(data) };
}

interface Scenario {
  listings?: Array<{ _id: Types.ObjectId; title: string }>;
  jobs?: Array<{ _id: Types.ObjectId; title: string }>;
  posts?: Array<{ _id: Types.ObjectId; body?: string }>;
  /** connect_view_daily rows: { targetId, count }. */
  listingViewRows?: Array<{ targetId: Types.ObjectId; count: number }>;
  /** post view-edge aggregate rows: { _id, c }. */
  postViewRows?: Array<{ _id: Types.ObjectId; c: number }>;
  /** job-view aggregate rows: { _id, c }. */
  jobViewRows?: Array<{ _id: Types.ObjectId; c: number }>;
  /** in-flight boost campaign rows. */
  campaigns?: Array<{
    sourceListingId?: Types.ObjectId;
    sourcePostId?: Types.ObjectId;
    sourceJobId?: Types.ObjectId;
  }>;
  dismissals?: Array<{ kind: string; entityId: Types.ObjectId }>;
  /** the global cool-down marker (null = none). */
  shown?: { lastShownAt: Date } | null;
  suppressed?: { listing?: string[]; job?: string[] };
}

function build(s: Scenario) {
  const listingModel = { find: vi.fn(() => q(s.listings ?? [])) };
  const jobModel = { find: vi.fn(() => q(s.jobs ?? [])) };
  const postModel = { find: vi.fn(() => q(s.posts ?? [])) };
  const viewDaily = { find: vi.fn(() => q(s.listingViewRows ?? [])) };
  const edgeModel = { aggregate: vi.fn(() => agg(s.postViewRows ?? [])) };
  const jobViewModel = { aggregate: vi.fn(() => agg(s.jobViewRows ?? [])) };
  const campaignModel = { find: vi.fn(() => q(s.campaigns ?? [])) };
  const dismissalModel = {
    find: vi.fn(() => q(s.dismissals ?? [])),
    updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const shownModel = {
    findOne: vi.fn(() => q(s.shown ?? null)),
    updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const overLimit = {
    getSuppressedIds: vi.fn((_owner: string, kind: 'listing' | 'job') =>
      Promise.resolve(s.suppressed?.[kind] ?? []),
    ),
  };

  const service = new BoostNudgeService(
    listingModel as any,
    jobModel as any,
    postModel as any,
    viewDaily as any,
    edgeModel as any,
    jobViewModel as any,
    campaignModel as any,
    dismissalModel as any,
    shownModel as any,
    overLimit as any,
  );
  return { service, dismissalModel, shownModel, overLimit };
}

/** A listing that clears its threshold, plus the matching daily-view rows. */
function tractionListing(title = 'Velvet roll') {
  const _id = new Types.ObjectId();
  return {
    row: { _id, title },
    viewRow: { targetId: _id, count: NUDGE_VIEW_THRESHOLDS.listing + 15 },
  };
}

describe('BoostNudgeService.getNudges', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a high-traction, eligible listing as a candidate', async () => {
    const L = tractionListing();
    const { service } = build({ listings: [L.row], listingViewRows: [L.viewRow] });

    const { candidates } = await service.getNudges(OWNER);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: 'listing',
      entityId: String(L.row._id),
      name: 'Velvet roll',
      windowDays: 7,
    });
    expect(candidates[0].viewsWindow).toBe(NUDGE_VIEW_THRESHOLDS.listing + 15);
  });

  it('EXCLUDES an entity below the view threshold', async () => {
    const _id = new Types.ObjectId();
    const { service } = build({
      listings: [{ _id, title: 'Quiet listing' }],
      listingViewRows: [{ targetId: _id, count: NUDGE_VIEW_THRESHOLDS.listing - 1 }],
    });

    const { candidates } = await service.getNudges(OWNER);
    expect(candidates).toHaveLength(0);
  });

  it('EXCLUDES a suppressed (over-limit) listing even with strong traction', async () => {
    const L = tractionListing();
    const { service } = build({
      listings: [L.row],
      listingViewRows: [L.viewRow],
      suppressed: { listing: [String(L.row._id)] },
    });

    const { candidates } = await service.getNudges(OWNER);
    expect(candidates).toHaveLength(0);
  });

  it('EXCLUDES an entity that already has an in-flight boost', async () => {
    const L = tractionListing();
    const { service } = build({
      listings: [L.row],
      listingViewRows: [L.viewRow],
      campaigns: [{ sourceListingId: L.row._id }],
    });

    const { candidates } = await service.getNudges(OWNER);
    expect(candidates).toHaveLength(0);
  });

  it('EXCLUDES an entity dismissed within the last 30 days', async () => {
    const L = tractionListing();
    const { service } = build({
      listings: [L.row],
      listingViewRows: [L.viewRow],
      dismissals: [{ kind: 'listing', entityId: L.row._id }],
    });

    const { candidates } = await service.getNudges(OWNER);
    expect(candidates).toHaveLength(0);
  });

  it('returns NOTHING while inside the global 7-day cool-down', async () => {
    const L = tractionListing();
    const { service, shownModel } = build({
      listings: [L.row],
      listingViewRows: [L.viewRow],
      shown: { lastShownAt: new Date() },
    });

    const { candidates } = await service.getNudges(OWNER);
    expect(candidates).toHaveLength(0);
    // The cool-down short-circuits before any candidate gathering.
    expect(shownModel.findOne).toHaveBeenCalledTimes(1);
  });

  it('ranks candidates across kinds by views desc and caps at 3', async () => {
    // listing 40, post 95, job 30, plus a second listing at 26 -> top 3 are
    // post(95), listing(40), job(30); the 26-view listing is dropped by the cap.
    const l1 = new Types.ObjectId();
    const l2 = new Types.ObjectId();
    const p1 = new Types.ObjectId();
    const j1 = new Types.ObjectId();
    const { service } = build({
      listings: [
        { _id: l1, title: 'L1' },
        { _id: l2, title: 'L2' },
      ],
      listingViewRows: [
        { targetId: l1, count: 40 },
        { targetId: l2, count: 26 },
      ],
      posts: [{ _id: p1, body: 'A great post about textile machinery and more' }],
      postViewRows: [{ _id: p1, c: 95 }],
      jobs: [{ _id: j1, title: 'J1' }],
      jobViewRows: [{ _id: j1, c: 30 }],
    });

    const { candidates } = await service.getNudges(OWNER);

    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => [c.kind, c.viewsWindow])).toEqual([
      ['post', 95],
      ['listing', 40],
      ['job', 30],
    ]);
  });

  it('derives a trimmed post name from the body', async () => {
    const p1 = new Types.ObjectId();
    const long = 'x'.repeat(200);
    const { service } = build({
      posts: [{ _id: p1, body: long }],
      postViewRows: [{ _id: p1, c: NUDGE_VIEW_THRESHOLDS.post + 1 }],
    });

    const { candidates } = await service.getNudges(OWNER);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name.endsWith('…')).toBe(true);
    expect(candidates[0].name.length).toBeLessThan(long.length);
  });
});

describe('BoostNudgeService.dismiss', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts an idempotent dismissal keyed by (owner, kind, entity)', async () => {
    const entityId = new Types.ObjectId().toHexString();
    const { service, dismissalModel } = build({});

    await service.dismiss(OWNER, 'job', entityId);
    await service.dismiss(OWNER, 'job', entityId); // repeat = idempotent

    expect(dismissalModel.updateOne).toHaveBeenCalledTimes(2);
    const [filter, update, opts] = dismissalModel.updateOne.mock.calls[0];
    expect(filter).toMatchObject({ kind: 'job' });
    expect(String(filter.ownerUserId)).toBe(OWNER);
    expect(String(filter.entityId)).toBe(entityId);
    expect(update.$set).toHaveProperty('dismissedAt');
    expect(opts).toEqual({ upsert: true });
  });
});

describe('BoostNudgeService.markShown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts the global cool-down marker for the owner', async () => {
    const { service, shownModel } = build({});

    await service.markShown(OWNER);

    expect(shownModel.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = shownModel.updateOne.mock.calls[0];
    expect(String(filter.ownerUserId)).toBe(OWNER);
    expect(update.$set).toHaveProperty('lastShownAt');
    expect(opts).toEqual({ upsert: true });
  });
});
