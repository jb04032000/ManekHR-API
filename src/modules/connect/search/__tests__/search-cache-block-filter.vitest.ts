/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SRCH-PERF-1 — end-to-end cache + security-ordering proof
 * (CONNECT-SEARCH-VERIFICATION-CHECKLIST.md §2: "a spike of identical prefixes
 * doesn't all hit Meili" AND §1: the per-viewer visibility filter still runs).
 *
 * This is the integration-level test the SRCH-PERF-1 spec asks for. It wires the
 * REAL stack — `FederatedSearchService` -> `SearchService` -> a REAL
 * `SearchCacheService` backed by a fake in-memory Redis -> a mocked Meili layer —
 * and proves, in one flow, the two invariants that matter together:
 *
 *   (a) THE CACHE WORKS: a second identical query within TTL returns the SAME
 *       engine payload WITHOUT a second Meili round-trip (Meili `multiSearch` is
 *       hit exactly once across two identical requests). This is the load-shed
 *       the checklist §2 requires.
 *
 *   (b) THE CACHE SITS BEFORE THE SECURITY FILTERS: even on the cache HIT (the
 *       second request), the per-viewer block filter in `FederatedSearchService`
 *       STILL runs over the cached ids, so a viewer who blocked an author never
 *       sees that author's row — a cached entry can NEVER leak blocked content.
 *       The cache stores only the viewer-independent engine ids; the block filter
 *       (and the live author-active gate) run per request, downstream of the
 *       cache read. This is the critical ordering: cache BEFORE visibility, never
 *       after.
 *
 * Approach: stub @nestjs/mongoose so the transitive schema imports don't trip
 * SchemaFactory reflection, then construct the services directly with controlled
 * mocks (the @nestjs/mongoose decorator-mock pattern, per backend CLAUDE.md).
 */

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

import { Types } from 'mongoose';
import { SearchService } from '../search.service';
import { FederatedSearchService } from '../federated-search.service';
import { SearchCacheService } from '../search-cache.service';

/** A query chain whose builder steps return itself; `.exec()` resolves `result`. */
function chain(result: unknown) {
  const c: any = {
    select: vi.fn(() => c),
    limit: vi.fn(() => c),
    sort: vi.fn(() => c),
    skip: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

/**
 * A minimal in-memory ioredis stand-in honouring the GET / SET(EX) contract the
 * cache uses. Good enough to prove a real cache HIT across two calls — the entry
 * written on the first (miss) call is read back on the second.
 */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  };
}

describe('SRCH-PERF-1 — cache + block-filter ordering (end-to-end)', () => {
  let profileModel: any;
  let userModel: any;
  let listingModel: any;
  let postModel: any;
  let jobModel: any;
  let connectProfileService: any;
  let meili: any;
  let erpLinkService: any;
  let allowanceService: any;

  beforeEach(() => {
    profileModel = { find: vi.fn(() => chain([])), findOne: vi.fn(() => chain(null)) };
    userModel = { find: vi.fn(() => chain([])), findById: vi.fn(() => chain(null)) };
    listingModel = {
      find: vi.fn(() => chain([])),
      findById: vi.fn(() => chain(null)),
      aggregate: vi.fn(() => chain([{ category: [], district: [] }])),
      countDocuments: vi.fn(() => chain(0)),
    };
    postModel = { find: vi.fn(() => chain([])), findById: vi.fn(() => chain(null)) };
    jobModel = { find: vi.fn(() => chain([])), findById: vi.fn(() => chain(null)) };
    connectProfileService = { getPeopleByIds: vi.fn().mockResolvedValue([]) };
    // Meili is ENABLED here — the cache only fronts the Meili engine path.
    meili = { enabled: true, multiSearch: vi.fn() };
    erpLinkService = {
      getUserStatus: vi.fn().mockResolvedValue({ linked: false, since: null, signals: {} }),
    };
    allowanceService = {
      getAllowances: vi.fn().mockResolvedValue({
        maxListings: 25,
        leadsPerMonth: -1,
        includedBoostCredits: 0,
        verifiedBadge: false,
        searchPriority: 0,
      }),
    };
  });

  /** Wire SearchService with a REAL SearchCacheService over the supplied fake Redis. */
  function buildSearchService(redis: any) {
    const cache = new SearchCacheService(redis);
    return new SearchService(
      profileModel,
      userModel,
      listingModel,
      postModel,
      jobModel,
      connectProfileService,
      meili,
      erpLinkService,
      allowanceService,
      undefined as never, // overLimit (@Optional) — no-op under freeze
      cache,
    );
  }

  /** Wire FederatedSearchService over the given SearchService, with a real-ish block filter. */
  function buildFederated(searchService: SearchService, blockedIds: string[]) {
    const tagService: any = { normalizeHashtags: vi.fn((t: string[]) => Promise.resolve(t)) };
    // Mirrors SearchBlockFilterService: symmetric blocked set + pure filterRows.
    const blockFilter: any = {
      getBlockedUserIds: vi.fn().mockResolvedValue(new Set<string>(blockedIds)),
      filterRows: (rows: any[], authorIdOf: (r: any) => string, blocked: ReadonlySet<string>) =>
        blocked.size === 0 ? rows : rows.filter((r) => !blocked.has(String(authorIdOf(r)))),
    };
    return new FederatedSearchService(
      searchService,
      tagService,
      undefined, // posthog optional
      undefined, // reviews optional
      blockFilter,
    );
  }

  it('(a) a second identical query within TTL hits Meili once; (b) the block filter STILL runs on the cache HIT', async () => {
    const blockedSeller = new Types.ObjectId();
    const okSeller = new Types.ObjectId();
    const blockedListingId = new Types.ObjectId();
    const okListingId = new Types.ObjectId();

    // The Meili engine returns BOTH sellers' listing ids (it has no notion of the
    // viewer's blocks — that is exactly why the block filter must run downstream).
    meili.multiSearch = vi.fn().mockResolvedValue([
      {
        hits: [{ id: String(blockedListingId) }, { id: String(okListingId) }],
        estimatedTotalHits: 2,
        facetDistribution: {},
      },
    ]);

    const mk = (id: Types.ObjectId, owner: Types.ObjectId, title: string) => ({
      _id: id,
      ownerUserId: owner,
      title,
      description: 'x',
      category: 'embroidery-zari',
      priceType: 'fixed',
      priceMin: 100,
      priceMax: null,
      unit: 'per-meter',
      status: 'active',
      moderationStatus: 'approved',
      location: { district: 'Surat' },
      images: [],
      tags: [],
      createdAt: new Date(),
    });
    // Hydration always returns both rows; both owners are active (so the live
    // author-active gate is a no-op here — we are isolating the BLOCK filter).
    listingModel.find = vi.fn(() =>
      chain([
        mk(blockedListingId, blockedSeller, 'Blocked shop'),
        mk(okListingId, okSeller, 'Live shop'),
      ]),
    );
    userModel.find = vi.fn(() => chain([{ _id: blockedSeller }, { _id: okSeller }]));

    const redis = fakeRedis();
    const searchService = buildSearchService(redis);
    const federated = buildFederated(searchService, [String(blockedSeller)]);

    // Request #1 — cache MISS: Meili is queried, the engine ids are cached.
    const first = await federated.search({ q: 'zari', type: 'listings' }, 'viewer-id');
    // Request #2 — IDENTICAL query within TTL: cache HIT, Meili is NOT re-queried.
    const second = await federated.search({ q: 'zari', type: 'listings' }, 'viewer-id');

    // (a) THE CACHE WORKS: one Meili round-trip absorbed two identical requests.
    expect(meili.multiSearch).toHaveBeenCalledTimes(1);
    // The Redis entry written on the miss was read back on the hit.
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledTimes(2);

    // (b) THE BLOCK FILTER STILL RUNS — on BOTH requests, including the cache HIT.
    // The blocked seller's listing is absent from BOTH responses (cache cannot
    // leak past the per-viewer visibility filter), the live seller's remains, and
    // the count is leak-free (1, not the engine's 2).
    for (const out of [first, second]) {
      expect(out.listings.map((l: any) => l.title)).toEqual(['Live shop']);
      expect(out.listings.map((l: any) => l.listingId)).not.toContain(String(blockedListingId));
      expect(out.listingsTotal).toBe(1);
    }
  });

  it('a different query is a separate cache key (no false hit) and triggers its own Meili call', async () => {
    const sellerA = new Types.ObjectId();
    const listingA = new Types.ObjectId();
    meili.multiSearch = vi
      .fn()
      .mockResolvedValue([
        { hits: [{ id: String(listingA) }], estimatedTotalHits: 1, facetDistribution: {} },
      ]);
    listingModel.find = vi.fn(() =>
      chain([
        {
          _id: listingA,
          ownerUserId: sellerA,
          title: 'A',
          status: 'active',
          moderationStatus: 'approved',
          location: { district: 'Surat' },
          images: [],
          tags: [],
        },
      ]),
    );
    userModel.find = vi.fn(() => chain([{ _id: sellerA }]));

    const searchService = buildSearchService(fakeRedis());
    const federated = buildFederated(searchService, []);

    await federated.search({ q: 'zari', type: 'listings' }, 'viewer-id');
    await federated.search({ q: 'saree', type: 'listings' }, 'viewer-id'); // different query text

    // Two distinct queries -> two distinct cache keys -> two Meili round-trips.
    expect(meili.multiSearch).toHaveBeenCalledTimes(2);
  });
});
