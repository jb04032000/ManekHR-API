/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the transitive
// decorated schema imports do not trip vitest's reflect-metadata pipeline.
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

// CN-LIM-2: mutable holder for CONNECT_LIMITS_ENFORCED so a test can flip the
// master kill switch. The env mock reads it via a getter, so the service's
// call-time read (`limitsEnforced()`) picks up the current value. Default `true`
// mirrors the production default AND keeps every existing suppression/reconcile
// test below (which assume enforcement is on) unchanged. Same pattern as
// connect-allowance.service.vitest.ts.
const flagState = vi.hoisted(() => ({ enforced: true }));
vi.mock('../../../../config/env', () => ({
  env: {
    connectLimits: {
      get enforced() {
        return flagState.enforced;
      },
    },
  },
}));

import { Types } from 'mongoose';
import {
  ConnectOverLimitService,
  computeSuppressedIds,
  graceElapsed,
} from '../connect-over-limit.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── In-memory fakes ──────────────────────────────────────────────────────────

interface FakeItem {
  _id: Types.ObjectId;
  owner: string;
  status: string;
  createdAt: number;
}

/** A model over an array of items. Supports the query shapes the service uses. */
function fakeItemModel(items: FakeItem[]) {
  const match = (filter: Record<string, any>): FakeItem[] =>
    items.filter((d) => {
      for (const [k, v] of Object.entries(filter)) {
        if (k === 'status') {
          if (v && typeof v === 'object' && Array.isArray(v.$in)) {
            if (!v.$in.includes(d.status)) return false;
          } else if (d.status !== v) return false;
        } else if (k === 'ownerUserId' || k === 'companyUserId') {
          if (String(d.owner) !== String(v)) return false;
        }
      }
      return true;
    });
  return {
    countDocuments: (filter: Record<string, any>) => ({ exec: async () => match(filter).length }),
    find: (filter: Record<string, any>) => {
      let rows = match(filter);
      const builder: any = {
        select: () => builder,
        sort: () => {
          rows = [...rows].sort((a, b) => b.createdAt - a.createdAt); // createdAt desc
          return builder;
        },
        lean: () => builder,
        exec: async () => rows.map((r) => ({ _id: r._id })),
      };
      return builder;
    },
    distinct: () => ({ exec: async () => items.map((d) => new Types.ObjectId(d.owner)) }),
  };
}

interface FakeState {
  userId: string;
  kind: string;
  overLimitSince: Date | null;
  notifiedAt: Date | null;
}

/** A faithful-enough fake of the over-limit state model (findOne / updateOne+upsert). */
function fakeStateModel(seed: FakeState[] = []) {
  const store = new Map<string, FakeState>();
  for (const s of seed) store.set(`${s.userId}:${s.kind}`, { ...s });
  const matches = (doc: FakeState, filter: Record<string, any>): boolean => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === 'userId') {
        if (String(doc.userId) !== String(v)) return false;
      } else if (k === 'kind') {
        if (doc.kind !== v) return false;
      } else if (k === 'overLimitSince') {
        if (v === null) {
          if (doc.overLimitSince !== null) return false;
        } else if (v && typeof v === 'object' && v.$ne === null) {
          if (doc.overLimitSince === null) return false;
        }
      }
    }
    return true;
  };
  const findDoc = (filter: Record<string, any>): FakeState | null => {
    for (const d of store.values()) if (matches(d, filter)) return d;
    return null;
  };
  return {
    _store: store,
    findOne: (filter: Record<string, any>) => {
      const get = () => findDoc(filter);
      return { lean: () => ({ exec: async () => get() }), exec: async () => get() };
    },
    updateOne: (filter: Record<string, any>, update: Record<string, any>, opts?: any) => ({
      exec: async () => {
        const doc = findDoc(filter);
        if (doc) {
          if (update.$set) Object.assign(doc, update.$set);
          return;
        }
        if (opts?.upsert) {
          const base: FakeState = {
            userId: String(filter.userId),
            kind: filter.kind,
            overLimitSince: null,
            notifiedAt: null,
          };
          if (update.$setOnInsert) Object.assign(base, update.$setOnInsert);
          if (update.$set) Object.assign(base, update.$set);
          store.set(`${base.userId}:${base.kind}`, base);
        }
      },
    }),
  };
}

const FREE = {
  maxListings: 25,
  maxStorefronts: 1,
  maxCompanyPages: 1,
  maxJobs: 10,
  storageMb: 500,
  overLimitPolicy: 'freeze' as const,
  overLimitGraceDays: 30,
};

function listing(owner: string, createdAt: number): FakeItem {
  return { _id: new Types.ObjectId(), owner, status: 'active', createdAt };
}

function build(opts: {
  listings?: FakeItem[];
  allow?: Record<string, unknown>;
  state?: FakeState[];
}) {
  const listingModel = fakeItemModel(opts.listings ?? []);
  const empty = fakeItemModel([]);
  const stateModel = fakeStateModel(opts.state ?? []);
  const allowances = { getAllowances: vi.fn().mockResolvedValue(opts.allow ?? FREE) };
  const notifications = { dispatch: vi.fn().mockResolvedValue({ _id: 'n' }) };
  const service = new ConnectOverLimitService(
    listingModel as any,
    empty as any,
    empty as any,
    empty as any,
    stateModel as any,
    allowances as any,
    notifications as any,
  );
  return { service, listingModel, stateModel, allowances, notifications };
}

// CN-LIM-2: always restore the master flag to ON before each test so a
// kill-switch test that flips it OFF can never leak into a later block.
beforeEach(() => {
  flagState.enforced = true;
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('computeSuppressedIds', () => {
  it('returns [] when unlimited (-1)', () => {
    expect(computeSuppressedIds(['a', 'b', 'c'], -1)).toEqual([]);
  });
  it('returns [] when within or at limit', () => {
    expect(computeSuppressedIds(['a', 'b'], 2)).toEqual([]);
    expect(computeSuppressedIds(['a'], 2)).toEqual([]);
  });
  it('suppresses exactly the newest (count - limit), given newest-first order', () => {
    // newest-first: [n5, n4, n3, n2, n1]; limit 2 keeps oldest 2 (n2,n1)
    expect(computeSuppressedIds(['n5', 'n4', 'n3', 'n2', 'n1'], 2)).toEqual(['n5', 'n4', 'n3']);
  });
  it('limit 0 suppresses everything', () => {
    expect(computeSuppressedIds(['a', 'b'], 0)).toEqual(['a', 'b']);
  });
});

describe('graceElapsed', () => {
  const now = new Date('2026-06-12T00:00:00Z');
  it('false when no clock', () => {
    expect(graceElapsed(null, 30, now)).toBe(false);
  });
  it('false within the window', () => {
    expect(graceElapsed(new Date(now.getTime() - 10 * MS_PER_DAY), 30, now)).toBe(false);
  });
  it('true once the window has fully elapsed', () => {
    expect(graceElapsed(new Date(now.getTime() - 31 * MS_PER_DAY), 30, now)).toBe(true);
  });
  it('graceDays 0 elapses immediately', () => {
    expect(graceElapsed(new Date(now.getTime() - 1), 0, now)).toBe(true);
  });
});

// ── reconcileUser: state surfacing + episode + notification ──────────────────

const USER = new Types.ObjectId().toHexString();

describe('ConnectOverLimitService.reconcileUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('freeze: over-limit surfaces state but never suppresses, and starts the clock', async () => {
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t));
    const f = build({ listings: items, allow: { ...FREE, maxListings: 2 } });

    const rows = await f.service.reconcileUser(USER);
    const row = rows.find((r) => r.kind === 'listing');

    expect(row.overLimit).toBe(true);
    expect(row.used).toBe(5);
    expect(row.limit).toBe(2);
    expect(row.policy).toBe('freeze');
    expect(row.suppressionActive).toBe(false);
    expect(row.suppressedCount).toBe(0);
    expect(row.overLimitSince).not.toBeNull(); // clock started
    // Entry notice fired once, with freeze wording.
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(1);
    const arg = f.notifications.dispatch.mock.calls[0][0];
    expect(arg.category).toBe('connect.over_limit');
    expect(arg.message).toContain('existing items stay live');
  });

  it('notifies exactly once per episode (no nightly spam)', async () => {
    const items = [1, 2, 3].map((t) => listing(USER, t));
    const f = build({ listings: items, allow: { ...FREE, maxListings: 1 } });

    await f.service.reconcileUser(USER);
    await f.service.reconcileUser(USER);
    await f.service.reconcileUser(USER);

    expect(f.notifications.dispatch).toHaveBeenCalledTimes(1);
  });

  it('clears the episode when back under limit, and re-notifies on a fresh episode', async () => {
    // Episode 1: over.
    const over = [1, 2, 3].map((t) => listing(USER, t));
    const f = build({ listings: over, allow: { ...FREE, maxListings: 1 } });
    await f.service.reconcileUser(USER);
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(1);

    // Back under limit: drop to 1 listing → episode ends (clock cleared).
    (f.listingModel as any).countDocuments = (_filter: any) => ({ exec: () => Promise.resolve(1) });
    (f.listingModel as any).find = () => ({
      select: () => ({
        sort: () => ({ lean: () => ({ exec: () => Promise.resolve([{ _id: over[0]._id }]) }) }),
      }),
    });
    const under = await f.service.reconcileUser(USER);
    expect(under.find((r) => r.kind === 'listing').overLimit).toBe(false);
    expect(under.find((r) => r.kind === 'listing').overLimitSince).toBeNull();

    // Over again → new episode → notifies again (total 2).
    (f.listingModel as any).countDocuments = (_filter: any) => ({ exec: () => Promise.resolve(3) });
    await f.service.reconcileUser(USER);
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(2);
  });

  it('hide_newest within grace surfaces the deadline but does not suppress yet', async () => {
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t));
    const f = build({
      listings: items,
      allow: { ...FREE, maxListings: 2, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 },
    });

    const rows = await f.service.reconcileUser(USER);
    const row = rows.find((r) => r.kind === 'listing');
    expect(row.overLimit).toBe(true);
    expect(row.suppressionActive).toBe(false); // just entered → within grace
    expect(row.graceEndsAt).not.toBeNull();
    const arg = f.notifications.dispatch.mock.calls[0][0];
    expect(arg.message).toContain('hidden from public');
  });

  it('hide_newest after grace marks suppression active for the excess', async () => {
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t));
    const since = new Date(Date.now() - 31 * MS_PER_DAY);
    const f = build({
      listings: items,
      allow: { ...FREE, maxListings: 2, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 },
      state: [{ userId: USER, kind: 'listing', overLimitSince: since, notifiedAt: since }],
    });

    const rows = await f.service.reconcileUser(USER);
    const row = rows.find((r) => r.kind === 'listing');
    expect(row.suppressionActive).toBe(true);
    expect(row.suppressedCount).toBe(3); // 5 - 2
  });
});

// ── getSuppressedIds / filterSuppressed: the read-time set ───────────────────

describe('ConnectOverLimitService.getSuppressedIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('freeze policy → always empty (byte-identical public behavior)', async () => {
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t));
    const since = new Date(Date.now() - 99 * MS_PER_DAY);
    const f = build({
      listings: items,
      allow: { ...FREE, maxListings: 2, overLimitPolicy: 'freeze' },
      state: [{ userId: USER, kind: 'listing', overLimitSince: since, notifiedAt: since }],
    });
    expect(await f.service.getSuppressedIds(USER, 'listing')).toEqual([]);
  });

  it('hide_newest within grace → empty', async () => {
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t));
    const since = new Date(Date.now() - 5 * MS_PER_DAY);
    const f = build({
      listings: items,
      allow: { ...FREE, maxListings: 2, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 },
      state: [{ userId: USER, kind: 'listing', overLimitSince: since, notifiedAt: since }],
    });
    expect(await f.service.getSuppressedIds(USER, 'listing')).toEqual([]);
  });

  it('hide_newest after grace → the newest (count - limit) ids', async () => {
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t)); // createdAt 1..5
    const newest3 = [items[4]._id, items[3]._id, items[2]._id].map(String); // 5,4,3
    const since = new Date(Date.now() - 31 * MS_PER_DAY);
    const f = build({
      listings: items,
      allow: { ...FREE, maxListings: 2, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 },
      state: [{ userId: USER, kind: 'listing', overLimitSince: since, notifiedAt: since }],
    });
    expect(await f.service.getSuppressedIds(USER, 'listing')).toEqual(newest3);
  });

  it('deleting an item shrinks the suppressed set automatically (computed, not stored)', async () => {
    const items = [1, 2, 3, 4].map((t) => listing(USER, t)); // 4 items, limit 2 → 2 suppressed
    const since = new Date(Date.now() - 31 * MS_PER_DAY);
    const f = build({
      listings: items,
      allow: { ...FREE, maxListings: 2, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 },
      state: [{ userId: USER, kind: 'listing', overLimitSince: since, notifiedAt: since }],
    });
    expect((await f.service.getSuppressedIds(USER, 'listing')).length).toBe(2);
  });

  it('re-upgrade (limit → -1) instantly un-suppresses everything', async () => {
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t));
    const since = new Date(Date.now() - 99 * MS_PER_DAY);
    const f = build({
      listings: items,
      allow: { ...FREE, maxListings: -1, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 },
      state: [{ userId: USER, kind: 'listing', overLimitSince: since, notifiedAt: since }],
    });
    expect(await f.service.getSuppressedIds(USER, 'listing')).toEqual([]);
  });

  it('passive user with no grace clock yet is never suppressed (fair warning first)', async () => {
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t));
    const f = build({
      listings: items,
      allow: { ...FREE, maxListings: 2, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 },
      state: [], // no clock started
    });
    expect(await f.service.getSuppressedIds(USER, 'listing')).toEqual([]);
  });
});

describe('ConnectOverLimitService.filterSuppressed', () => {
  it('drops only the suppressed owner’s newest items from a multi-owner page', async () => {
    const OWNER_A = new Types.ObjectId().toHexString();
    const OWNER_B = new Types.ObjectId().toHexString();
    const aItems = [1, 2, 3, 4, 5].map((t) => listing(OWNER_A, t)); // A over, hide_newest
    const since = new Date(Date.now() - 31 * MS_PER_DAY);

    const listingModel = fakeItemModel(aItems);
    const empty = fakeItemModel([]);
    const stateModel = fakeStateModel([
      { userId: OWNER_A, kind: 'listing', overLimitSince: since, notifiedAt: since },
    ]);
    const allowances = {
      getAllowances: vi
        .fn()
        .mockImplementation(async (uid: string) =>
          uid === OWNER_A
            ? { ...FREE, maxListings: 2, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 }
            : { ...FREE, overLimitPolicy: 'freeze' },
        ),
    };
    const notifications = { dispatch: vi.fn() };
    const service = new ConnectOverLimitService(
      listingModel as any,
      empty as any,
      empty as any,
      empty as any,
      stateModel as any,
      allowances as any,
      notifications as any,
    );

    // A page mixing A's newest-3 (suppressed) + A's oldest-2 (kept) + a B item.
    const bItem = { id: new Types.ObjectId().toHexString(), owner: OWNER_B };
    const page = [...aItems.map((i) => ({ id: String(i._id), owner: OWNER_A })), bItem];

    const kept = await service.filterSuppressed(
      page,
      'listing',
      (x) => x.owner,
      (x) => x.id,
    );

    // A's newest 3 dropped; A's oldest 2 kept; B untouched → 3 remain.
    expect(kept.length).toBe(3);
    expect(kept.some((x) => x.owner === OWNER_B)).toBe(true);
    const keptAIds = kept.filter((x) => x.owner === OWNER_A).map((x) => x.id);
    expect(keptAIds.sort()).toEqual([String(aItems[0]._id), String(aItems[1]._id)].sort());
  });
});

// ── CN-LIM-2: CONNECT_LIMITS_ENFORCED is a real kill switch for the WHOLE feature ─
//
// With the master flag OFF, the over-limit feature must be fully inert — not just
// the creation gates (already covered in connect-allowance.service.vitest.ts).
// Each case sets up a state that WOULD suppress / clock / notify when the flag is
// on (an over-limit hide_newest user past their grace window) and asserts the
// flag-off path produces zero effect.
describe('ConnectOverLimitService — CONNECT_LIMITS_ENFORCED kill switch (CN-LIM-2)', () => {
  const overLimitHideNewestPastGrace = () => {
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t)); // 5 items
    const since = new Date(Date.now() - 31 * MS_PER_DAY); // grace elapsed
    return build({
      listings: items,
      allow: { ...FREE, maxListings: 2, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 },
      state: [{ userId: USER, kind: 'listing', overLimitSince: since, notifiedAt: since }],
    });
  };

  it('sanity: with the flag ON this exact setup DOES suppress (guards the test)', async () => {
    const f = overLimitHideNewestPastGrace();
    expect((await f.service.getSuppressedIds(USER, 'listing')).length).toBe(3);
  });

  it('flag OFF: getSuppressedIds returns [] even for an over-limit hide_newest user past grace', async () => {
    flagState.enforced = false;
    const f = overLimitHideNewestPastGrace();
    expect(await f.service.getSuppressedIds(USER, 'listing')).toEqual([]);
  });

  it('flag OFF: filterSuppressed is a full pass-through (no item dropped)', async () => {
    flagState.enforced = false;
    const f = overLimitHideNewestPastGrace();
    const page = [1, 2, 3, 4, 5].map((_, i) => ({ id: `x${i}`, owner: USER }));
    const kept = await f.service.filterSuppressed(
      page,
      'listing',
      (x) => x.owner,
      (x) => x.id,
    );
    expect(kept).toEqual(page);
  });

  it('flag OFF: reconcileUser reports accurate used/limit but zero enforcement state', async () => {
    flagState.enforced = false;
    const f = overLimitHideNewestPastGrace();
    const rows = await f.service.reconcileUser(USER);
    const row = rows.find((r) => r.kind === 'listing');

    // Counts stay truthful so GET /me/connect/usage still renders correctly...
    expect(row.used).toBe(5);
    expect(row.limit).toBe(2);
    expect(row.overLimit).toBe(true);
    // ...but every enforcement-derived field is inert (no clock, no deadline, no hiding).
    expect(row.overLimitSince).toBeNull();
    expect(row.graceEndsAt).toBeNull();
    expect(row.suppressionActive).toBe(false);
    expect(row.suppressedCount).toBe(0);
  });

  it('flag OFF: reconcileUser fires NO over-limit notice and writes NO grace-clock state', async () => {
    flagState.enforced = false;
    // Start from a CLEAN state store (no pre-seeded clock) so we can prove the
    // reconcile does not create one when the feature is disabled.
    const items = [1, 2, 3, 4, 5].map((t) => listing(USER, t));
    const f = build({
      listings: items,
      allow: { ...FREE, maxListings: 2, overLimitPolicy: 'hide_newest', overLimitGraceDays: 30 },
      state: [],
    });

    await f.service.reconcileUser(USER);

    expect(f.notifications.dispatch).not.toHaveBeenCalled();
    // No episode row was written for the over-limit kind.
    expect((f.stateModel as any)._store.size).toBe(0);
  });
});
