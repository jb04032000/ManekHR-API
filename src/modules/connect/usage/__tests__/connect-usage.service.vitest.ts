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
import { ConnectUsageService } from '../connect-usage.service';

const USER = new Types.ObjectId().toHexString();

const FREE_ALLOW = {
  maxListings: 25,
  maxStorefronts: 1,
  maxCompanyPages: 1,
  maxJobs: 10,
  storageMb: 500,
  overLimitPolicy: 'freeze' as const,
  overLimitGraceDays: 30,
};

/** Default over-limit metadata block (freeze, within limit) for a kind. */
function status(kind: string, used: number, limit: number, over = false) {
  return {
    kind,
    used,
    limit,
    overLimit: over,
    policy: 'freeze' as const,
    graceDays: 30,
    overLimitSince: null,
    graceEndsAt: null,
    suppressionActive: false,
    suppressedCount: 0,
  };
}

function build(opts: {
  kindStatuses: ReturnType<typeof status>[];
  storageMb: number;
  allow?: Record<string, unknown>;
}) {
  const allowances = { getAllowances: vi.fn().mockResolvedValue(opts.allow ?? FREE_ALLOW) };
  const uploads = { getConnectStorageUsedMb: vi.fn().mockResolvedValue(opts.storageMb) };
  const overLimit = { reconcileUser: vi.fn().mockResolvedValue(opts.kindStatuses) };
  const service = new ConnectUsageService(allowances as any, uploads as any, overLimit as any);
  return { service, allowances, uploads, overLimit };
}

describe('ConnectUsageService.getUsageForUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns one row per count limit plus storage, surfacing over-limit state', async () => {
    const f = build({
      kindStatuses: [
        status('listing', 3, 25),
        status('storefront', 1, 1),
        status('company_page', 0, 1),
        status('job', 4, 10),
      ],
      storageMb: 120.5,
    });

    const rows = await f.service.getUsageForUser(USER);

    expect(rows.map((r) => ({ kind: r.kind, used: r.used, limit: r.limit }))).toEqual([
      { kind: 'listing', used: 3, limit: 25 },
      { kind: 'storefront', used: 1, limit: 1 },
      { kind: 'company_page', used: 0, limit: 1 },
      { kind: 'job', used: 4, limit: 10 },
      { kind: 'storage', used: 120.5, limit: 500 },
    ]);
    // Every row carries the additive over-limit fields.
    for (const r of rows) {
      expect(r).toHaveProperty('overLimit');
      expect(r).toHaveProperty('policy');
      expect(r).toHaveProperty('suppressionActive');
      expect(r).toHaveProperty('suppressedCount');
    }
  });

  it('reconciles the four item kinds via the over-limit service (single source of counts)', async () => {
    const f = build({
      kindStatuses: [
        status('listing', 5, 5),
        status('storefront', 0, 1),
        status('company_page', 0, 1),
        status('job', 0, 10),
      ],
      storageMb: 0,
    });

    await f.service.getUsageForUser(USER);

    expect(f.overLimit.reconcileUser).toHaveBeenCalledWith(USER);
  });

  it('surfaces an over-limit listing row (used > limit) with its policy', async () => {
    const f = build({
      kindStatuses: [
        { ...status('listing', 30, 25, true), policy: 'freeze' },
        status('storefront', 0, 1),
        status('company_page', 0, 1),
        status('job', 0, 10),
      ],
      storageMb: 0,
    });

    const rows = await f.service.getUsageForUser(USER);
    const listing = rows.find((r) => r.kind === 'listing');
    expect(listing.overLimit).toBe(true);
    expect(listing.policy).toBe('freeze');
  });

  it('marks the storage row over-limit when used exceeds the cap, never suppressing', async () => {
    const f = build({
      kindStatuses: [
        status('listing', 0, 25),
        status('storefront', 0, 1),
        status('company_page', 0, 1),
        status('job', 0, 10),
      ],
      storageMb: 750,
      allow: { ...FREE_ALLOW, storageMb: 500 },
    });

    const rows = await f.service.getUsageForUser(USER);
    const storage = rows.find((r) => r.kind === 'storage');
    expect(storage.overLimit).toBe(true);
    expect(storage.suppressionActive).toBe(false);
    expect(storage.suppressedCount).toBe(0);
  });

  it('passes through unlimited (-1) storage unchanged (never over-limit)', async () => {
    const f = build({
      kindStatuses: [
        status('listing', 999, -1),
        status('storefront', 3, -1),
        status('company_page', 2, -1),
        status('job', 50, -1),
      ],
      storageMb: 4096,
      allow: { ...FREE_ALLOW, storageMb: -1 },
    });

    const rows = await f.service.getUsageForUser(USER);
    const storage = rows.find((r) => r.kind === 'storage');
    expect(storage.limit).toBe(-1);
    expect(storage.overLimit).toBe(false);
    expect(storage.used).toBe(4096);
  });

  it('reuses the uploads storage aggregation for the storage row', async () => {
    const f = build({
      kindStatuses: [
        status('listing', 0, 25),
        status('storefront', 0, 1),
        status('company_page', 0, 1),
        status('job', 0, 10),
      ],
      storageMb: 42,
    });

    await f.service.getUsageForUser(USER);

    expect(f.uploads.getConnectStorageUsedMb).toHaveBeenCalledWith(USER);
  });
});
