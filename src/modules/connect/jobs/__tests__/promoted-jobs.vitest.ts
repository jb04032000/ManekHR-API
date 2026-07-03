/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// TagService -> src/config/env.ts -> dotenv/config. Stub so the unit test loads
// without a real env file (matches jobs.service.vitest.ts).
vi.mock('dotenv/config', () => ({}));

// Stub @nestjs/mongoose BEFORE importing the services so transitive schema
// imports skip vitest's reflect-metadata pipeline.
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
import { JobsService } from '../jobs.service';
import { JobBoostResolverService } from '../../ads/services/job-boost-resolver.service';

const JOB_A = new Types.ObjectId(); // active boost, open, matches filter
const JOB_B = new Types.ObjectId(); // active boost, CLOSED -> excluded
const JOB_C = new Types.ObjectId(); // active boost, open, but filtered out
const JOB_D = new Types.ObjectId(); // active boost, open, matches (for cap test)

// ---------------------------------------------------------------------------
// JobBoostResolverService.resolveActiveJobBoosts
// ---------------------------------------------------------------------------

describe('JobBoostResolverService.resolveActiveJobBoosts', () => {
  it('queries active boost-job campaigns + approved promoted_job creatives, returns distinct jobRefs (read-only)', async () => {
    // The aggregation returns one row per distinct jobRef (grouped + projected).
    const aggregate = vi.fn().mockResolvedValue([{ _id: JOB_A }, { _id: JOB_D }]);
    const campaignModel: any = { aggregate };
    const svc = new JobBoostResolverService(campaignModel);

    const refs = await svc.resolveActiveJobBoosts(3);

    expect(refs).toEqual([{ jobId: String(JOB_A) }, { jobId: String(JOB_D) }]);

    // Assert the eligibility predicates (active window + budget on the campaign,
    // approved promoted_job creative join). NO impression/decide/wallet call.
    const pipeline = aggregate.mock.calls[0][0];
    const match = pipeline.find((s: any) => s.$match)?.$match;
    expect(match.kind).toBe('boost_job');
    expect(match.status).toBe('active');
    expect(match.startAt.$lte).toBeInstanceOf(Date);
    expect(match.endAt.$gt).toBeInstanceOf(Date);
    expect(match.$expr).toEqual({ $lt: ['$budgetSpent', '$totalBudget'] });

    const lookup = pipeline.find((s: any) => s.$lookup)?.$lookup;
    expect(lookup.from).toBe('ad_creatives');
    const creativeMatch = lookup.pipeline.find((s: any) => s.$match)?.$match;
    expect(creativeMatch.kind).toBe('promoted_job');
    expect(creativeMatch.reviewStatus).toBe('approved');
    expect(creativeMatch.jobRef).toEqual({ $ne: null });
  });

  it('returns [] for a non-positive limit without touching the DB', async () => {
    const aggregate = vi.fn();
    const svc = new JobBoostResolverService({ aggregate } as any);
    expect(await svc.resolveActiveJobBoosts(0)).toEqual([]);
    expect(aggregate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// JobsService.listPromotedForBoard
// ---------------------------------------------------------------------------

/** Fluent find().lean().exec() chain whose terminal exec resolves `result`. */
function findChain(result: unknown) {
  const obj: any = {
    lean: vi.fn(() => obj),
    exec: vi.fn().mockResolvedValue(result),
  };
  return obj;
}

describe('JobsService.listPromotedForBoard', () => {
  let jobModel: any;
  let resolver: any;

  function buildService(findResult: unknown, refs: { jobId: string }[]) {
    jobModel = { find: vi.fn(() => findChain(findResult)) };
    resolver = { resolveActiveJobBoosts: vi.fn().mockResolvedValue(refs) };
    const stub = () => ({}) as any;
    return new JobsService(
      jobModel,
      stub(), // applicationModel
      stub(), // jobViewModel
      stub(), // savedJobModel
      stub(), // userModel
      stub(), // allowances
      stub(), // companyPages
      stub(), // notifications
      stub(), // audit
      stub(), // eventEmitter
      stub(), // tagService
      undefined, // posthog
      resolver, // jobBoosts
    );
  }

  beforeEach(() => vi.clearAllMocks());

  it('excludes a non-open job, a job filtered out, and caps to limit; preserves resolver order', async () => {
    // Resolver returns A, B, C, D (newest first).
    const refs = [
      { jobId: String(JOB_A) },
      { jobId: String(JOB_B) },
      { jobId: String(JOB_C) },
      { jobId: String(JOB_D) },
    ];
    // The DB find applies status:'open' + the board filter + _id $in, so it only
    // returns A and D (B is closed -> dropped by the status:'open' filter; C does
    // not match the active filter -> dropped). Returned out of order to prove the
    // service re-orders to the resolver sequence.
    const matched = [
      { _id: JOB_D, status: 'open', title: 'D' },
      { _id: JOB_A, status: 'open', title: 'A' },
    ];
    const svc = buildService(matched, refs);

    const out = await svc.listPromotedForBoard({ district: 'Varachha' }, 2);

    // A before D (resolver order), B + C excluded, capped to 2.
    expect(out.map((j: any) => j.title)).toEqual(['A', 'D']);

    // The find filter pins status:'open' and the boosted id set.
    const filterArg = jobModel.find.mock.calls[0][0];
    expect(filterArg.status).toBe('open');
    expect(filterArg._id.$in).toHaveLength(4);

    // Asked the resolver for more than the cap (headroom for post-filtering).
    expect(resolver.resolveActiveJobBoosts).toHaveBeenCalledWith(6);
  });

  it('returns [] when there are no active boosts', async () => {
    const svc = buildService([], []);
    expect(await svc.listPromotedForBoard({}, 3)).toEqual([]);
    expect(jobModel.find).not.toHaveBeenCalled();
  });

  it('returns [] when the resolver is absent (no AdsModule wiring)', async () => {
    const stub = () => ({}) as any;
    const svc = new JobsService(
      { find: vi.fn() } as any,
      stub(),
      stub(),
      stub(),
      stub(),
      stub(),
      stub(),
      stub(),
      stub(),
      stub(),
      stub(),
      undefined,
      undefined, // jobBoosts absent
    );
    expect(await svc.listPromotedForBoard({}, 3)).toEqual([]);
  });
});
