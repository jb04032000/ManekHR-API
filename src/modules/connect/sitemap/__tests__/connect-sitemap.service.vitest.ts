/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive schema imports (Listing, Job, ConnectProfile, ...) don't trip the
// "Cannot determine type" reflection error under vitest's esbuild transform.
// Every Model is injected as a plain chainable mock (no real Mongoose).
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
import { ConnectSitemapService, SITEMAP_CHUNK_SIZE } from '../connect-sitemap.service';

/** A chainable find() stub that records the filter + the skip/limit it was given. */
function makeFindModel() {
  const calls: { filter: any; skip?: number; limit?: number; select?: string; sort?: any } = {
    filter: undefined,
  };
  let rows: any[] = [];
  const model: any = {
    __calls: calls,
    __setRows: (r: any[]) => {
      rows = r;
    },
    countDocuments: vi.fn((filter: any) => {
      calls.filter = filter;
      return { exec: vi.fn(() => Promise.resolve(rows.length)) };
    }),
    find: vi.fn((filter: any) => {
      calls.filter = filter;
      const q: any = {
        select: vi.fn((s: string) => {
          calls.select = s;
          return q;
        }),
        sort: vi.fn((s: any) => {
          calls.sort = s;
          return q;
        }),
        skip: vi.fn((n: number) => {
          calls.skip = n;
          return q;
        }),
        limit: vi.fn((n: number) => {
          calls.limit = n;
          return q;
        }),
        lean: vi.fn(() => q),
        exec: vi.fn(() => Promise.resolve(rows)),
      };
      return q;
    }),
  };
  return model;
}

describe('ConnectSitemapService', () => {
  let listingModel: any;
  let storefrontModel: any;
  let companyPageModel: any;
  let jobModel: any;
  let profileModel: any;
  let userModel: any;
  let overLimit: any;
  let svc: ConnectSitemapService;

  beforeEach(() => {
    listingModel = makeFindModel();
    storefrontModel = makeFindModel();
    companyPageModel = makeFindModel();
    jobModel = makeFindModel();
    profileModel = makeFindModel();
    userModel = makeFindModel();
    // filterSuppressed default = identity (freeze): returns the page unchanged.
    overLimit = {
      filterSuppressed: vi.fn((items: any[]) => Promise.resolve(items)),
    };
    svc = new ConnectSitemapService(
      listingModel,
      storefrontModel,
      companyPageModel,
      jobModel,
      profileModel,
      userModel,
      overLimit,
    );
  });

  // ── Per-section filters are the correct public/active gate ──────────────────

  it('listings filter = active + approved only', async () => {
    listingModel.__setRows([
      { _id: new Types.ObjectId(), ownerUserId: new Types.ObjectId(), updatedAt: new Date() },
    ]);
    await svc.section('listings', 0);
    expect(listingModel.__calls.filter).toEqual({ status: 'active', moderationStatus: 'approved' });
  });

  it('stores + companyPages filter = visibility public only', async () => {
    await svc.section('stores', 0);
    await svc.section('companyPages', 0);
    expect(storefrontModel.__calls.filter).toEqual({ visibility: 'public' });
    expect(companyPageModel.__calls.filter).toEqual({ visibility: 'public' });
  });

  it('profiles filter = visibility public only', async () => {
    profileModel.__setRows([]);
    await svc.section('profiles', 0);
    expect(profileModel.__calls.filter).toEqual({ visibility: 'public' });
  });

  it('jobs filter = status open only (closed/filled excluded)', async () => {
    await svc.section('jobs', 0);
    expect(jobModel.__calls.filter).toEqual({ status: 'open' });
  });

  // ── ref shape per section ───────────────────────────────────────────────────

  it('store/companyPage ref = slug, job/listing ref = _id', async () => {
    const sId = new Types.ObjectId();
    storefrontModel.__setRows([{ slug: 'velvet-house', updatedAt: new Date('2026-01-01') }]);
    const jId = new Types.ObjectId();
    jobModel.__setRows([{ _id: jId, updatedAt: new Date('2026-02-02') }]);

    const stores = await svc.section('stores', 0);
    const jobs = await svc.section('jobs', 0);

    expect(stores.entries).toEqual([
      { ref: 'velvet-house', updatedAt: new Date('2026-01-01').toISOString() },
    ]);
    expect(jobs.entries).toEqual([
      { ref: String(jId), updatedAt: new Date('2026-02-02').toISOString() },
    ]);
    void sId;
  });

  it('drops storefronts with an empty slug', async () => {
    storefrontModel.__setRows([
      { slug: '', updatedAt: new Date() },
      { slug: 'ok', updatedAt: new Date() },
    ]);
    const res = await svc.section('stores', 0);
    expect(res.entries.map((e) => e.ref)).toEqual(['ok']);
  });

  // ── Listing suppression reuse ───────────────────────────────────────────────

  it('excludes over-limit-suppressed listings via filterSuppressed', async () => {
    const keep = new Types.ObjectId();
    const drop = new Types.ObjectId();
    const owner = new Types.ObjectId();
    listingModel.__setRows([
      { _id: keep, ownerUserId: owner, updatedAt: new Date('2026-03-03') },
      { _id: drop, ownerUserId: owner, updatedAt: new Date('2026-03-04') },
    ]);
    // Simulate suppression dropping the second row.
    overLimit.filterSuppressed.mockImplementation((items: any[]) =>
      Promise.resolve(items.filter((r) => String(r._id) === String(keep))),
    );

    const res = await svc.section('listings', 0);

    expect(overLimit.filterSuppressed).toHaveBeenCalledWith(
      expect.any(Array),
      'listing',
      expect.any(Function),
      expect.any(Function),
    );
    expect(res.entries.map((e) => e.ref)).toEqual([String(keep)]);
  });

  // ── Profile handle join (ref = handle; handleless skipped) ───────────────────

  it('profiles ref = owning user handle; public-but-handleless skipped', async () => {
    const uWithHandle = new Types.ObjectId();
    const uNoHandle = new Types.ObjectId();
    profileModel.__setRows([
      { userId: uWithHandle, updatedAt: new Date('2026-04-04') },
      { userId: uNoHandle, updatedAt: new Date('2026-04-05') },
    ]);
    // Only the first user comes back from the handle-filtered User query.
    userModel.__setRows([{ _id: uWithHandle, handle: 'master-aari' }]);

    const res = await svc.section('profiles', 0);

    // The User query enforces a non-empty handle.
    expect(userModel.__calls.filter).toMatchObject({ handle: { $nin: [null, ''] } });
    expect(res.entries).toEqual([
      { ref: 'master-aari', updatedAt: new Date('2026-04-04').toISOString() },
    ]);
  });

  // ── Chunk offset / limit math ───────────────────────────────────────────────

  it('chunk math: skip = chunk * SITEMAP_CHUNK_SIZE, limit = SITEMAP_CHUNK_SIZE', async () => {
    jobModel.__setRows([]);
    await svc.section('jobs', 2);
    expect(jobModel.__calls.skip).toBe(2 * SITEMAP_CHUNK_SIZE);
    expect(jobModel.__calls.limit).toBe(SITEMAP_CHUNK_SIZE);
    // Stable paging is sorted by _id.
    expect(jobModel.__calls.sort).toEqual({ _id: 1 });
  });

  it('chunk defaults to 0 when omitted', async () => {
    jobModel.__setRows([]);
    await svc.section('jobs');
    expect(jobModel.__calls.skip).toBe(0);
  });

  it('rejects a negative chunk', async () => {
    await expect(svc.section('jobs', -1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown section', async () => {
    await expect(svc.section('bogus' as any, 0)).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── counts ──────────────────────────────────────────────────────────────────

  it('counts returns per-section totals on the public/active filters', async () => {
    listingModel.__setRows([{}, {}, {}]); // 3 active+approved
    storefrontModel.__setRows([{}]); // 1 public store
    companyPageModel.__setRows([{}, {}]); // 2 public pages
    jobModel.__setRows([{}, {}, {}, {}]); // 4 open jobs
    // profiles count = public profiles whose user has a handle.
    profileModel.__setRows([{ userId: new Types.ObjectId() }, { userId: new Types.ObjectId() }]);
    userModel.__setRows([{}]); // only 1 of the 2 has a handle

    const counts = await svc.counts();

    expect(counts).toEqual({ listings: 3, stores: 1, companyPages: 2, profiles: 1, jobs: 4 });
    // Each count query used the right filter.
    expect(listingModel.countDocuments).toHaveBeenCalledWith({
      status: 'active',
      moderationStatus: 'approved',
    });
    expect(storefrontModel.countDocuments).toHaveBeenCalledWith({ visibility: 'public' });
    expect(jobModel.countDocuments).toHaveBeenCalledWith({ status: 'open' });
    expect(userModel.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ handle: { $nin: [null, ''] } }),
    );
  });
});
