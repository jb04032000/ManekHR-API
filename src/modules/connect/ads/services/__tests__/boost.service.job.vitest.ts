/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * BoostService.createJobBoost unit tests (Phase 5) -- strict TDD.
 *
 * Mirrors boost.service.listing.vitest.ts. Covers ONLY the job-boost path; the
 * shipped post + listing pipelines are proven inert by their own specs. All
 * Mongo models, WalletService, RollupReader, PostHog, and the Job model are
 * in-process fakes.
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
import type { CreateJobBoostInput, RollupReader } from '../boost.service';

function makeId(): string {
  return new Types.ObjectId().toHexString();
}

// Owner ids are real ObjectId hex strings: the job schema stores
// `companyUserId` as an ObjectId and BoostService now compares with `.equals()`.
const OWNER = '64a000000000000000000001';
const OTHER = '64a000000000000000000002';

function createFakeCampaignModel(existingBoost?: { _id: string; status: string }) {
  const created: any[] = [];
  const deletedIds: string[] = [];
  return {
    _created: created,
    _deletedIds: deletedIds,
    create(data: Record<string, any>) {
      const doc = { _id: makeId(), save: vi.fn().mockResolvedValue(undefined), ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },
    findById(id: string) {
      if (existingBoost && String(existingBoost._id) === String(id)) {
        return Promise.resolve(existingBoost);
      }
      return Promise.resolve(null);
    },
    updateOne(_filter: Record<string, any>, _update: Record<string, any>) {
      return Promise.resolve({ modifiedCount: 1 });
    },
    deleteOne(filter: Record<string, any>) {
      deletedIds.push(String(filter._id));
      return Promise.resolve({ deletedCount: 1 });
    },
  };
}

function createFakeBundleModel() {
  const created: any[] = [];
  const deletedIds: string[] = [];
  return {
    _created: created,
    _deletedIds: deletedIds,
    create(data: Record<string, any>) {
      const doc = { _id: makeId(), ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },
    deleteOne(filter: Record<string, any>) {
      deletedIds.push(String(filter._id));
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

function makeJobDoc(overrides: Record<string, any> = {}) {
  return {
    _id: makeId(),
    companyUserId: new Types.ObjectId(OWNER),
    status: 'open',
    boostCampaignId: null as string | null,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createFakeJobModel(seed: ReturnType<typeof makeJobDoc> | null) {
  return {
    findById(id: string) {
      if (seed && String(seed._id) === String(id)) return Promise.resolve(seed);
      return Promise.resolve(null);
    },
  };
}

const BASE: Omit<CreateJobBoostInput, 'jobId'> = {
  ownerUserId: OWNER,
  objective: 'reach',
  totalBudget: 500,
  days: 7,
  targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
};

function buildService(opts: {
  job: ReturnType<typeof makeJobDoc> | null;
  reserve?: boolean;
  existingBoost?: { _id: string; status: string };
  posthog?: { capture: ReturnType<typeof vi.fn> };
  noJobModel?: boolean;
}) {
  const campaignModel = createFakeCampaignModel(opts.existingBoost);
  const adSetModel = createFakeBundleModel();
  const creativeModel = createFakeBundleModel();
  const wallet = createFakeWallet(opts.reserve ?? true);
  const jobModel = opts.noJobModel ? undefined : createFakeJobModel(opts.job);

  // Positions: campaign, adSet, creative, wallet, rollups, posthog, listingModel, jobModel.
  const svc = new BoostService(
    campaignModel as any,
    adSetModel as any,
    creativeModel as any,
    wallet as any,
    createFakeRollups(),
    opts.posthog as any,
    undefined as any, // listingModel - not used on the job path
    jobModel as any,
  );

  return { svc, campaignModel, adSetModel, creativeModel, wallet };
}

describe('BoostService.createJobBoost (Phase 5)', () => {
  it('open + owned job: creates boost_job + promoted_job on jobs_rail, reserves, links boostCampaignId', async () => {
    const job = makeJobDoc({ status: 'open', boostCampaignId: null });
    const { svc, adSetModel, creativeModel, wallet } = buildService({ job });

    const result = await svc.createJobBoost({ ...BASE, jobId: String(job._id) });

    expect(result.kind).toBe('boost_job');
    expect(result.billingEvent).toBe('cpm');
    expect(result.bid).toBe(40);
    // Publish-then-moderate: a launched boost serves immediately (active).
    expect(result.status).toBe('active');
    expect(result.sourceJobId).toBe(String(job._id));

    expect(adSetModel._created[0].placements).toEqual(['feed_sponsored']);

    const creative = creativeModel._created[0];
    expect(creative.kind).toBe('promoted_job');
    expect(creative.jobRef).toBe(String(job._id));
    expect(creative.listingRef).toBeUndefined();
    expect(creative.postRef).toBeUndefined();

    expect(wallet.reserveDetailed).toHaveBeenCalledWith(OWNER, 500, String(result._id));
    expect(String(job.boostCampaignId)).toBe(String(result._id));
    expect(job.save).toHaveBeenCalled();
  });

  it('applications objective: billingEvent cpc, bid 4', async () => {
    const job = makeJobDoc();
    const { svc } = buildService({ job });
    const result = await svc.createJobBoost({
      ...BASE,
      jobId: String(job._id),
      objective: 'applications',
    });
    expect(result.billingEvent).toBe('cpc');
    expect(result.bid).toBe(4);
  });

  it('missing job: NotFoundException', async () => {
    const { svc } = buildService({ job: null });
    await expect(svc.createJobBoost({ ...BASE, jobId: 'does-not-exist' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('job owned by another user: NotFoundException (no ownership leak)', async () => {
    const job = makeJobDoc({ companyUserId: new Types.ObjectId(OTHER) });
    const { svc, adSetModel } = buildService({ job });
    await expect(svc.createJobBoost({ ...BASE, jobId: String(job._id) })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(adSetModel._created).toHaveLength(0);
  });

  it('a closed job: BadRequestException (only an open job can be boosted)', async () => {
    const job = makeJobDoc({ status: 'closed' });
    const { svc, adSetModel } = buildService({ job });
    await expect(svc.createJobBoost({ ...BASE, jobId: String(job._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(adSetModel._created).toHaveLength(0);
  });

  it('job with an in-flight (active) boost: BadRequestException', async () => {
    const existingBoost = { _id: makeId(), status: 'active' };
    const job = makeJobDoc({ boostCampaignId: existingBoost._id });
    const { svc } = buildService({ job, existingBoost });
    await expect(svc.createJobBoost({ ...BASE, jobId: String(job._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('wallet reserve fails: BadRequestException, all 3 docs cleaned up, job NOT linked', async () => {
    const job = makeJobDoc({ boostCampaignId: null });
    const { svc, campaignModel, adSetModel, creativeModel } = buildService({ job, reserve: false });
    await expect(svc.createJobBoost({ ...BASE, jobId: String(job._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(campaignModel._deletedIds).toHaveLength(1);
    expect(adSetModel._deletedIds).toHaveLength(1);
    expect(creativeModel._deletedIds).toHaveLength(1);
    expect(job.save).not.toHaveBeenCalled();
    expect(job.boostCampaignId).toBeNull();
  });

  it('emits ads.boost_created with target=job when posthog is provided', async () => {
    const job = makeJobDoc();
    const posthog = { capture: vi.fn() };
    const { svc } = buildService({ job, posthog });
    const result = await svc.createJobBoost({
      ...BASE,
      jobId: String(job._id),
      objective: 'applications',
    });
    expect(posthog.capture).toHaveBeenCalledOnce();
    const call = posthog.capture.mock.calls[0][0];
    expect(call.event).toBe('ads.boost_created');
    expect(call.properties.target).toBe('job');
    expect(call.properties.jobId).toBe(String(job._id));
    expect(call.properties.campaignId).toBe(String(result._id));
  });

  it('throws a clear error when the Job model is not injected', async () => {
    const { svc } = buildService({ job: null, noJobModel: true });
    await expect(svc.createJobBoost({ ...BASE, jobId: 'x' })).rejects.toThrow(/jobModel/);
  });
});
