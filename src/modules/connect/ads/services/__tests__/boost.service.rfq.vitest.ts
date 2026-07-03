/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * BoostService.createRfqBoost unit tests -- strict TDD.
 *
 * Artifact-based boost (mirrors boost.service.job.vitest.ts): the RFQ must be
 * owned by the caller (buyer) + `open`, with no in-flight boost. Default audience
 * = the RFQ trade category. Serves on the `rfq_board` rail placement.
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
import type { CreateRfqBoostInput, RollupReader } from '../boost.service';

function makeId(): string {
  return new Types.ObjectId().toHexString();
}

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
    updateOne(_f: Record<string, any>, _u: Record<string, any>) {
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
    reserveDetailed: vi.fn().mockImplementation((_o: string, amount: number) =>
      Promise.resolve({
        ok: reserveResult,
        fromGrant: 0,
        fromBalance: reserveResult ? amount : 0,
      }),
    ),
    forfeitReserve: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
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

function makeRfqDoc(overrides: Record<string, any> = {}) {
  return {
    _id: makeId(),
    buyerUserId: new Types.ObjectId(OWNER),
    status: 'open',
    category: 'weaving',
    boostCampaignId: null as string | null,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createFakeRfqModel(seed: ReturnType<typeof makeRfqDoc> | null) {
  return {
    findById(id: string) {
      if (seed && String(seed._id) === String(id)) return Promise.resolve(seed);
      return Promise.resolve(null);
    },
  };
}

const BASE: Omit<CreateRfqBoostInput, 'rfqId'> = {
  ownerUserId: OWNER,
  objective: 'reach',
  totalBudget: 500,
  days: 7,
  targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
};

function buildService(opts: {
  rfq: ReturnType<typeof makeRfqDoc> | null;
  reserve?: boolean;
  existingBoost?: { _id: string; status: string };
  posthog?: { capture: ReturnType<typeof vi.fn> };
  noRfqModel?: boolean;
}) {
  const campaignModel = createFakeCampaignModel(opts.existingBoost);
  const adSetModel = createFakeBundleModel();
  const creativeModel = createFakeBundleModel();
  const wallet = createFakeWallet(opts.reserve ?? true);
  const rfqModel = opts.noRfqModel ? undefined : createFakeRfqModel(opts.rfq);

  // rfqModel is the LAST positional arg (position 12), after profileModel.
  const svc = new BoostService(
    campaignModel as any, // 0 campaignModel
    adSetModel as any, // 1 adSetModel
    creativeModel as any, // 2 creativeModel
    wallet as any, // 3 wallet
    createFakeRollups(), // 4 rollups
    opts.posthog as any, // 5 posthog
    undefined as any, // 6 listingModel
    undefined as any, // 7 jobModel
    undefined, // 8 rollupModel
    undefined, // 9 postModel
    undefined, // 10 pricingConfig
    undefined, // 11 profileModel
    rfqModel as any, // 12 rfqModel
  );
  return { svc, campaignModel, adSetModel, creativeModel, wallet };
}

describe('BoostService.createRfqBoost', () => {
  it('open + owned RFQ: creates boost_rfq + promoted_rfq on rfq_promoted, default category audience, links boostCampaignId', async () => {
    const rfq = makeRfqDoc({ status: 'open', category: 'weaving' });
    const { svc, adSetModel, creativeModel, wallet } = buildService({ rfq });

    const result = await svc.createRfqBoost({ ...BASE, rfqId: String(rfq._id) });

    expect(result.kind).toBe('boost_rfq');
    expect(result.billingEvent).toBe('cpm');
    expect(String(result.sourceRfqId)).toBe(String(rfq._id));

    expect(adSetModel._created[0].placements).toEqual(['rfq_promoted', 'feed_sponsored']);
    // Default trade audience = the RFQ category, since sectors were left empty.
    expect(adSetModel._created[0].targeting.sectors).toEqual(['weaving']);

    const creative = creativeModel._created[0];
    expect(creative.kind).toBe('promoted_rfq');
    expect(String(creative.rfqRef)).toBe(String(rfq._id));

    expect(wallet.reserveDetailed).toHaveBeenCalledWith(OWNER, 500, String(result._id));
    expect(String(rfq.boostCampaignId)).toBe(String(result._id));
    expect(rfq.save).toHaveBeenCalled();
  });

  it('quotes objective: billingEvent cpc', async () => {
    const rfq = makeRfqDoc();
    const { svc } = buildService({ rfq });
    const result = await svc.createRfqBoost({
      ...BASE,
      rfqId: String(rfq._id),
      objective: 'quotes',
    });
    expect(result.billingEvent).toBe('cpc');
  });

  it('keeps advertiser-supplied sectors (does not overwrite with the category default)', async () => {
    const rfq = makeRfqDoc({ category: 'weaving' });
    const { svc, adSetModel } = buildService({ rfq });
    await svc.createRfqBoost({
      ...BASE,
      rfqId: String(rfq._id),
      targeting: { roles: [], sectors: ['dyeing'], districts: [], companySizes: [] },
    });
    expect(adSetModel._created[0].targeting.sectors).toEqual(['dyeing']);
  });

  it('missing RFQ: NotFoundException', async () => {
    const { svc } = buildService({ rfq: null });
    await expect(svc.createRfqBoost({ ...BASE, rfqId: 'nope' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('RFQ owned by another user: NotFoundException (no ownership leak)', async () => {
    const rfq = makeRfqDoc({ buyerUserId: new Types.ObjectId(OTHER) });
    const { svc, adSetModel } = buildService({ rfq });
    await expect(svc.createRfqBoost({ ...BASE, rfqId: String(rfq._id) })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(adSetModel._created).toHaveLength(0);
  });

  it('a closed RFQ: BadRequestException', async () => {
    const rfq = makeRfqDoc({ status: 'closed' });
    const { svc, adSetModel } = buildService({ rfq });
    await expect(svc.createRfqBoost({ ...BASE, rfqId: String(rfq._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(adSetModel._created).toHaveLength(0);
  });

  it('RFQ with an in-flight (active) boost: BadRequestException', async () => {
    const existingBoost = { _id: makeId(), status: 'active' };
    const rfq = makeRfqDoc({ boostCampaignId: existingBoost._id });
    const { svc } = buildService({ rfq, existingBoost });
    await expect(svc.createRfqBoost({ ...BASE, rfqId: String(rfq._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('wallet reserve fails: BadRequestException, all 3 docs cleaned up, RFQ NOT linked', async () => {
    const rfq = makeRfqDoc({ boostCampaignId: null });
    const { svc, campaignModel, adSetModel, creativeModel } = buildService({ rfq, reserve: false });
    await expect(svc.createRfqBoost({ ...BASE, rfqId: String(rfq._id) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(campaignModel._deletedIds).toHaveLength(1);
    expect(adSetModel._deletedIds).toHaveLength(1);
    expect(creativeModel._deletedIds).toHaveLength(1);
    expect(rfq.save).not.toHaveBeenCalled();
    expect(rfq.boostCampaignId).toBeNull();
  });

  it('emits ads.boost_created with target=rfq', async () => {
    const rfq = makeRfqDoc();
    const posthog = { capture: vi.fn() };
    const { svc } = buildService({ rfq, posthog });
    const result = await svc.createRfqBoost({ ...BASE, rfqId: String(rfq._id) });
    const call = posthog.capture.mock.calls[0][0];
    expect(call.properties.target).toBe('rfq');
    expect(call.properties.rfqId).toBe(String(rfq._id));
    expect(call.properties.campaignId).toBe(String(result._id));
  });

  it('throws a clear error when the Rfq model is not injected', async () => {
    const { svc } = buildService({ rfq: null, noRfqModel: true });
    await expect(svc.createRfqBoost({ ...BASE, rfqId: 'x' })).rejects.toThrow(/rfqModel/);
  });
});
