/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing SearchService so the transitive
// schema imports (ConnectProfile / User) don't trip SchemaFactory reflection.
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
import { SearchService } from '../search.service';

/**
 * Unit coverage for `SearchService` — Connect people search (Wave 4 — B5).
 * Exercises the Mongo-regex fallback (Meilisearch disabled) + the Meili path,
 * the blank-query short-circuit, the public-profile gate on name hits, and the
 * result cap. The models, `ConnectProfileService`, and `MeiliClient` are mocked.
 */

/** A query chain whose steps return itself; `.exec()` resolves `result`. */
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

describe('SearchService — Connect people search (Phase 2, Wave 4)', () => {
  let profileModel: any;
  let userModel: any;
  let listingModel: any;
  let postModel: any;
  let jobModel: any;
  let connectProfileService: any;
  let meili: any;
  let erpLinkService: any;
  let allowanceService: any;

  function build() {
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
    );
  }

  // CN-SRCH-2 (Bucket 5) added two query-time gates to searchPeople:
  //   userModel.find({_id:{$in}, isActive:true})  -> active owners
  //   profileModel.find({userId:{$in}, visibility:'public'}) -> live-public
  // These helpers make the DEFAULT mocks GATE-PERMISSIVE (echo the queried $in
  // ids as active + public) so the ordering/paging tests are unaffected. The
  // gate-specific tests below install their own restrictive stubs. A search-side
  // profileModel.find (no userId.$in) still returns whatever a test configured.
  function activeUserFind(filter: any) {
    const ids = filter?._id?.$in ?? [];
    return chain(ids.map((id: any) => ({ _id: id })));
  }
  function publicProfileGateFind(filter: any, configured: () => any) {
    // The CN-SRCH-2 gate query is keyed by userId.$in + visibility:'public'.
    if (filter?.userId?.$in && filter?.visibility === 'public') {
      return chain(filter.userId.$in.map((id: any) => ({ userId: id })));
    }
    return configured();
  }

  beforeEach(() => {
    // profileModel.find: gate query echoes $in as public; otherwise empty (a test
    // that exercises the search fallback overrides `.find` with its match set).
    let profileFindResult: unknown = [];
    profileModel = {
      find: vi.fn((filter: any) => publicProfileGateFind(filter, () => chain(profileFindResult))),
      findOne: vi.fn(() => chain(null)),
      _setFindResult: (r: unknown) => {
        profileFindResult = r;
      },
    };
    userModel = {
      find: vi.fn((filter: any) => activeUserFind(filter)),
      findById: vi.fn(() => chain(null)),
    };
    listingModel = {
      find: vi.fn(() => chain([])),
      findById: vi.fn(() => chain(null)),
      // browseRecentListings runs a $facet aggregation for the corpus category +
      // district counts; default to empty facet buckets (one row, no groups).
      aggregate: vi.fn(() => chain([{ category: [], district: [] }])),
      // browseRecentListings + searchListings now thread a `total` match count
      // (the marketplace infinite-scroll hasMore). browse derives it from a
      // countDocuments over the public corpus; default 0 in the empty case.
      countDocuments: vi.fn(() => chain(0)),
    };
    postModel = {
      find: vi.fn(() => chain([])),
      findById: vi.fn(() => chain(null)),
    };
    jobModel = {
      find: vi.fn(() => chain([])),
      findById: vi.fn(() => chain(null)),
    };
    connectProfileService = { getPeopleByIds: vi.fn().mockResolvedValue([]) };
    // Default: Meilisearch not configured, so the Mongo fallback runs.
    meili = {
      enabled: false,
      multiSearch: vi.fn().mockResolvedValue([{ hits: [] }]),
      upsertDocuments: vi.fn().mockResolvedValue(undefined),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      ensureIndex: vi.fn().mockResolvedValue(undefined),
    };
    erpLinkService = {
      getUserStatus: vi.fn().mockResolvedValue({ linked: false, since: null, signals: {} }),
    };
    // Default: a free seller — not verified, no search priority (M2.3).
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

  it('returns an empty page (no rows, zero total) for a blank query without touching either backend', async () => {
    const result = await build().searchPeople('   ');
    expect(result).toEqual({ people: [], total: 0 });
    expect(profileModel.find).not.toHaveBeenCalled();
    expect(meili.multiSearch).not.toHaveBeenCalled();
  });

  it('Mongo fallback: matches a public profile on headline / skills', async () => {
    const u1 = new Types.ObjectId();
    // Search-side profile match set; the gate query (visibility:'public') is
    // served filter-aware by the default mock (echoes $in as public).
    profileModel._setFindResult([{ userId: u1 }]);
    // No name hits from the search; the gate's active-owner read is served
    // filter-aware (echoes _id.$in as active) so u1 passes CN-SRCH-2.
    userModel.find = vi.fn((filter: any) =>
      filter?._id?.$in ? activeUserFind(filter) : chain([]),
    );
    connectProfileService.getPeopleByIds = vi
      .fn()
      .mockResolvedValue([
        { userId: String(u1), name: 'Meera', avatar: null, headline: 'Zari karigar' },
      ]);

    const result = await build().searchPeople('zari');

    expect(connectProfileService.getPeopleByIds).toHaveBeenCalledWith([String(u1)]);
    expect(result.people).toHaveLength(1);
  });

  it('Mongo fallback: a name hit only counts when the user has a public profile', async () => {
    const u2 = new Types.ObjectId();
    // 1st search find — profile headline/skill matches (none); the fallback's
    // own public-profile check for name hits + the CN-SRCH-2 gate are both keyed
    // by userId.$in and served by the filter-aware default (echoes $in public).
    profileModel.find = vi.fn((filter: any) => {
      if (filter?.userId?.$in) return chain(filter.userId.$in.map((id: any) => ({ userId: id })));
      return chain([]); // headline/skills text search: no direct match
    });
    userModel.find = vi.fn((filter: any) =>
      filter?._id?.$in ? chain([{ _id: u2 }]) : chain([{ _id: u2 }]),
    );
    connectProfileService.getPeopleByIds = vi
      .fn()
      .mockResolvedValue([{ userId: String(u2), name: 'Vikas', avatar: null, headline: null }]);

    const result = await build().searchPeople('vikas');

    expect(connectProfileService.getPeopleByIds).toHaveBeenCalledWith([String(u2)]);
    expect(result.people).toHaveLength(1);
  });

  it('caps the result set at 25', async () => {
    const many = Array.from({ length: 40 }, () => ({ userId: new Types.ObjectId() }));
    profileModel._setFindResult(many);
    userModel.find = vi.fn((filter: any) =>
      filter?._id?.$in ? activeUserFind(filter) : chain([]),
    );

    await build().searchPeople('a');

    const passedIds = connectProfileService.getPeopleByIds.mock.calls[0][0];
    expect(passedIds).toHaveLength(25);
  });

  it('uses the Meilisearch backend when it is enabled', async () => {
    const u1 = new Types.ObjectId();
    meili = {
      enabled: true,
      multiSearch: vi.fn().mockResolvedValue([{ hits: [{ id: String(u1) }] }]),
    };
    connectProfileService.getPeopleByIds = vi
      .fn()
      .mockResolvedValue([{ userId: String(u1), name: 'Meera', avatar: null, headline: null }]);

    const result = await build().searchPeople('meera');

    expect(meili.multiSearch).toHaveBeenCalled();
    // Note: profileModel.find IS now called for the CN-SRCH-2 live-visibility
    // gate (not the Mongo fallback). The gate query is served filter-aware
    // (echoes the hit ids as public), so the Meili hit still hydrates.
    expect(connectProfileService.getPeopleByIds).toHaveBeenCalledWith([String(u1)]);
    expect(result.people).toHaveLength(1);
  });

  // ── Phase 2 (progressive loading): people pagination + total ──────────────

  it('returns the Meili estimatedTotalHits as the people total (leak-free hasMore source)', async () => {
    const u1 = new Types.ObjectId();
    meili = {
      enabled: true,
      // Meili reports the corpus-wide match count separately from this page's hits.
      multiSearch: vi
        .fn()
        .mockResolvedValue([{ hits: [{ id: String(u1) }], estimatedTotalHits: 137 }]),
    };
    connectProfileService.getPeopleByIds = vi
      .fn()
      .mockResolvedValue([{ userId: String(u1), name: 'Meera', avatar: null, headline: null }]);

    const result = await build().searchPeople('meera');

    expect(result.people).toHaveLength(1);
    expect(result.total).toBe(137);
  });

  // ── CN-SRCH-2: query-time gates (suspended owner / stale-hidden profile) ───

  it('CN-SRCH-2: a suspended (isActive:false) Meili hit never hydrates (dropped by the active gate)', async () => {
    const u1 = new Types.ObjectId();
    meili = {
      enabled: true,
      multiSearch: vi
        .fn()
        .mockResolvedValue([{ hits: [{ id: String(u1) }], estimatedTotalHits: 1 }]),
    };
    // Owner is NOT active -> the active gate returns empty -> the hit is dropped
    // even though the (stale) Meili index still lists them.
    userModel.find = vi.fn(() => chain([])); // no active owners
    connectProfileService.getPeopleByIds = vi.fn().mockResolvedValue([]);

    const result = await build().searchPeople('meera');

    expect(connectProfileService.getPeopleByIds).not.toHaveBeenCalled();
    expect(result.people).toHaveLength(0);
    expect(result.total).toBe(1); // corpus total is unaffected (leak-free hasMore)
  });

  it('CN-SRCH-2: a since-hidden profile (stale index row) never hydrates (dropped by the visibility gate)', async () => {
    const u1 = new Types.ObjectId();
    meili = {
      enabled: true,
      multiSearch: vi
        .fn()
        .mockResolvedValue([{ hits: [{ id: String(u1) }], estimatedTotalHits: 1 }]),
    };
    // Owner is active, but their live profile is no longer public -> the
    // visibility gate returns empty -> dropped despite the stale index row.
    userModel.find = vi.fn((filter: any) => activeUserFind(filter)); // active
    profileModel.find = vi.fn(() => chain([])); // no live-public profile
    connectProfileService.getPeopleByIds = vi.fn().mockResolvedValue([]);

    const result = await build().searchPeople('meera');

    expect(connectProfileService.getPeopleByIds).not.toHaveBeenCalled();
    expect(result.people).toHaveLength(0);
  });

  it('threads limit/offset into the Meili people query (the active-vertical page)', async () => {
    meili = {
      enabled: true,
      multiSearch: vi.fn().mockResolvedValue([{ hits: [], estimatedTotalHits: 0 }]),
    };

    await build().searchPeople('zari', {}, { limit: 12, offset: 24 });

    const [queries] = meili.multiSearch.mock.calls[0];
    expect(queries[0].limit).toBe(12);
    expect(queries[0].offset).toBe(24);
  });

  it('Mongo fallback: reports the matched count as total and pages the id slice', async () => {
    // 8 distinct profile matches; page = offset 2, limit 3 -> ids[2..4] hydrate.
    const ids = Array.from({ length: 8 }, () => new Types.ObjectId());
    // Search-side match set + gate (userId.$in visibility:'public') both served
    // filter-aware so the paged ids survive the CN-SRCH-2 gate unchanged.
    profileModel.find = vi.fn((filter: any) =>
      filter?.userId?.$in
        ? chain(filter.userId.$in.map((id: any) => ({ userId: id })))
        : chain(ids.map((id) => ({ userId: id }))),
    );
    userModel.find = vi.fn((filter: any) =>
      filter?._id?.$in ? activeUserFind(filter) : chain([]),
    );

    const result = await build().searchPeople('a', {}, { limit: 3, offset: 2 });

    expect(result.total).toBe(8);
    const passedIds = connectProfileService.getPeopleByIds.mock.calls[0][0];
    expect(passedIds).toEqual(ids.slice(2, 5).map((id) => String(id)));
  });

  it('Mongo fallback: consecutive pages are disjoint (no duplicate person on scroll)', async () => {
    const ids = Array.from({ length: 8 }, () => new Types.ObjectId());
    profileModel.find = vi.fn((filter: any) =>
      filter?.userId?.$in
        ? chain(filter.userId.$in.map((id: any) => ({ userId: id })))
        : chain(ids.map((id) => ({ userId: id }))),
    );
    userModel.find = vi.fn((filter: any) =>
      filter?._id?.$in ? activeUserFind(filter) : chain([]),
    );
    const svc = build();

    await svc.searchPeople('a', {}, { limit: 3, offset: 0 });
    await svc.searchPeople('a', {}, { limit: 3, offset: 3 });

    const page1 = connectProfileService.getPeopleByIds.mock.calls[0][0] as string[];
    const page2 = connectProfileService.getPeopleByIds.mock.calls[1][0] as string[];
    // The two windows share no id — offset pagination never re-serves a row, so
    // the web infinite scroll cannot show the same person twice.
    expect(page1.some((id) => page2.includes(id))).toBe(false);
    expect([...page1, ...page2]).toEqual(ids.slice(0, 6).map((id) => String(id)));
  });

  // ── S1.2 — candidate facet filters ───────────────────────────────────────

  it('returns an empty page for a blank query with no filters (browse needs a term or a facet)', async () => {
    const result = await build().searchPeople('', {});
    expect(result).toEqual({ people: [], total: 0 });
    expect(meili.multiSearch).not.toHaveBeenCalled();
    expect(profileModel.find).not.toHaveBeenCalled();
  });

  it('passes the people facet filter to Meili and hydrates the hits', async () => {
    const u1 = new Types.ObjectId();
    meili = {
      enabled: true,
      multiSearch: vi.fn().mockResolvedValue([{ hits: [{ id: String(u1) }] }]),
    };
    connectProfileService.getPeopleByIds = vi
      .fn()
      .mockResolvedValue([{ userId: String(u1), name: 'Asha' }]);

    await build().searchPeople('zari', { skills: ['Zari'], district: 'Surat', openToWork: true });

    const [queries] = meili.multiSearch.mock.calls[0];
    expect(queries[0].indexUid).toBe('connect_people');
    expect(queries[0].q).toBe('zari');
    expect(queries[0].filter).toEqual(
      expect.arrayContaining(['skills IN ["zari"]', 'district = "surat"', 'openToWork = true']),
    );
  });

  it('applies the facet filter to the Mongo fallback query when Meili is off', async () => {
    profileModel.find = vi.fn(() => chain([{ userId: new Types.ObjectId() }]));
    userModel.find = vi.fn(() => chain([]));

    await build().searchPeople('zari', { openToWork: true });

    const findArg = profileModel.find.mock.calls[0][0];
    expect(findArg.visibility).toBe('public');
    expect(findArg['openTo.work']).toBe(true);
  });

  it('runs a facet-only browse (blank query) through the Mongo fallback', async () => {
    profileModel.find = vi.fn(() => chain([{ userId: new Types.ObjectId() }]));
    userModel.find = vi.fn(() => chain([]));

    await build().searchPeople('', { openToWork: true });

    expect(profileModel.find).toHaveBeenCalled();
    const findArg = profileModel.find.mock.calls[0][0];
    expect(findArg['openTo.work']).toBe(true);
    expect(findArg.$or).toBeUndefined(); // no text term -> no text clause
  });

  // ── S1.2 — enriched indexing ──────────────────────────────────────────────

  it('indexes the enriched people document (facets + derived erpLinked + experienceYears)', async () => {
    const userId = new Types.ObjectId().toHexString();
    meili.enabled = true;
    userModel.findById = vi.fn(() => chain({ name: 'Asha' }));
    profileModel.findOne = vi.fn(() =>
      chain({
        headline: 'Zari karigar',
        skills: ['Zari', 'aari', 'zari'],
        visibility: 'public',
        district: 'Surat',
        openTo: { work: true, hiring: false },
        experience: [{ from: new Date(Date.now() - 6.5 * 365 * 24 * 60 * 60 * 1000), to: null }],
      }),
    );
    erpLinkService.getUserStatus = vi
      .fn()
      .mockResolvedValue({ linked: true, since: null, signals: {} });

    await build().indexPerson(userId);

    const [index, docs] = meili.upsertDocuments.mock.calls[0];
    expect(index).toBe('connect_people');
    expect(docs[0]).toMatchObject({
      id: userId,
      name: 'Asha',
      headline: 'Zari karigar',
      skills: ['zari', 'aari'],
      district: 'surat',
      openToWork: true,
      openToHiring: false,
      erpLinked: 1,
      experienceYears: 6,
    });
  });

  it('romanizes a Gujarati headline / skill into the indexed `romanized` field (SRCH-I18N-1)', async () => {
    meili.enabled = true;
    userModel.findById = vi.fn(() => chain({ name: 'Meera' }));
    profileModel.findOne = vi.fn(() =>
      chain({
        headline: 'સાડી work',
        skills: ['જરી'],
        visibility: 'public',
        district: 'Surat',
        openTo: {},
      }),
    );

    await build().indexPerson(new Types.ObjectId().toHexString());

    const [, docs] = meili.upsertDocuments.mock.calls[0];
    expect(docs[0].romanized).toContain('sadi'); // સાડી -> sadi
    expect(docs[0].romanized).toContain('jari'); // જરી -> jari
  });

  it('removes a non-public profile from the index without an ERP lookup', async () => {
    meili.enabled = true;
    userModel.findById = vi.fn(() => chain({ name: 'X' }));
    profileModel.findOne = vi.fn(() => chain({ visibility: 'hidden' }));

    await build().indexPerson(new Types.ObjectId().toHexString());

    expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
    expect(meili.upsertDocuments).not.toHaveBeenCalled();
    expect(erpLinkService.getUserStatus).not.toHaveBeenCalled();
  });

  // ─── M1.4 - marketplace listings ────────────────────────────────────────

  describe('browseRecentListings (marketplace landing)', () => {
    it('returns active+approved listings as refs (public gate, verified from owner)', async () => {
      const owner = new Types.ObjectId();
      const listingId = new Types.ObjectId();
      listingModel.find = vi.fn(() =>
        chain([
          {
            _id: listingId,
            ownerUserId: owner,
            title: 'Gold zari border',
            description: 'Bulk',
            category: 'embroidery-zari',
            priceType: 'fixed',
            priceMin: 500,
            priceMax: null,
            unit: 'per-meter',
            location: { district: 'Surat', city: 'Surat', state: 'Gujarat' },
            images: ['a.jpg'],
            status: 'active',
            moderationStatus: 'approved',
            createdAt: new Date('2026-01-01'),
          },
        ]),
      );
      allowanceService.getAllowances = vi.fn().mockResolvedValue({
        maxListings: 25,
        leadsPerMonth: -1,
        includedBoostCredits: 0,
        verifiedBadge: true,
        searchPriority: 0,
      });
      // Author-active gate (SRCH-LEAK-5): the owner's User row is active so the
      // listing survives the gate.
      userModel.find = vi.fn(() => chain([{ _id: owner }]));

      const result = await build().browseRecentListings(10);

      expect(listingModel.find).toHaveBeenCalledWith({
        status: 'active',
        moderationStatus: 'approved',
      });
      expect(result.listings).toHaveLength(1);
      expect(result.listings[0]).toMatchObject({
        listingId: String(listingId),
        title: 'Gold zari border',
        verified: true,
      });
    });

    it('returns empty listings (with empty count maps) when there are no public listings', async () => {
      listingModel.find = vi.fn(() => chain([]));
      const result = await build().browseRecentListings();
      expect(result.listings).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.categoryCounts).toEqual({});
      expect(result.districtCounts).toEqual({});
    });

    it('returns corpus category + district facet counts from the aggregation', async () => {
      // The $facet aggregation buckets the public corpus; districts are lowercased
      // by the pipeline ($toLower) so the keys match the Meili facet keys.
      listingModel.aggregate = vi.fn(() =>
        chain([
          {
            category: [
              { _id: 'embroidery-zari', n: 86 },
              { _id: 'weaving', n: 74 },
            ],
            district: [
              { _id: 'surat', n: 92 },
              { _id: 'ring road', n: 78 },
            ],
          },
        ]),
      );
      const result = await build().browseRecentListings();
      expect(result.categoryCounts).toEqual({ 'embroidery-zari': 86, weaving: 74 });
      expect(result.districtCounts).toEqual({ surat: 92, 'ring road': 78 });
    });

    // SECURITY (SRCH-LEAK-5): author-active gate on the marketplace bare-landing
    // browse. A banned / erased seller's listing (its own state is still
    // active+approved) must be dropped here too — the same leak the LEAK-1 gate
    // closes on the three Meili paths, on this different read path. The corpus
    // `total` must NOT stay inflated by the dropped card (clamped, never below the
    // remaining visible length).
    it('drops a recent listing whose owner account was erased / banned (isActive=false) and does not inflate total', async () => {
      const okOwner = new Types.ObjectId();
      const bannedOwner = new Types.ObjectId();
      const okListingId = new Types.ObjectId();
      const bannedListingId = new Types.ObjectId();
      const mk = (id: Types.ObjectId, ownerUserId: Types.ObjectId, title: string) => ({
        _id: id,
        ownerUserId,
        title,
        description: 'Bulk',
        category: 'embroidery-zari',
        priceType: 'fixed',
        priceMin: 500,
        priceMax: null,
        unit: 'per-meter',
        location: { district: 'Surat', city: 'Surat', state: 'Gujarat' },
        images: ['a.jpg'],
        status: 'active',
        moderationStatus: 'approved',
        createdAt: new Date('2026-01-01'),
      });
      listingModel.find = vi.fn(() =>
        chain([
          mk(okListingId, okOwner, 'Active seller listing'),
          mk(bannedListingId, bannedOwner, 'Banned seller listing'),
        ]),
      );
      // Corpus count over the public gate reports 2 (the listing's own state is
      // still active+approved for the banned owner too).
      listingModel.countDocuments = vi.fn(() => chain(2));
      // Author-active gate: only `okOwner` comes back as active; `bannedOwner` is
      // absent (isActive=false), so the gate's fail-closed `$in` treats it inactive.
      userModel.find = vi.fn(() => chain([{ _id: okOwner }]));

      const result = await build().browseRecentListings();

      // The banned seller's listing is gone; only the active seller's remains.
      expect(result.listings).toHaveLength(1);
      expect(result.listings[0]).toMatchObject({
        listingId: String(okListingId),
        title: 'Active seller listing',
      });
      expect(result.listings.some((l) => l.listingId === String(bannedListingId))).toBe(false);
      // total is decremented by the one dropped card (2 -> 1), not left at 2, and
      // never below the remaining visible length.
      expect(result.total).toBe(1);
      expect(result.total).toBeGreaterThanOrEqual(result.listings.length);
    });
  });

  describe('searchListings', () => {
    it('returns empty listings + empty facet count maps for a blank query with no filters', async () => {
      const result = await build().searchListings('   ');
      expect(result).toEqual({
        listings: [],
        total: 0,
        tagCounts: {},
        categoryCounts: {},
        districtCounts: {},
      });
      expect(listingModel.find).not.toHaveBeenCalled();
      expect(meili.multiSearch).not.toHaveBeenCalled();
    });

    it('Mongo fallback: queries title + description and pins the public gate', async () => {
      const id1 = new Types.ObjectId();
      const ownerId = new Types.ObjectId();
      const listingDoc = {
        _id: id1,
        ownerUserId: ownerId,
        title: 'Zari saree',
        description: 'Heavy work',
        category: 'embroidery-zari',
        priceType: 'range',
        priceMin: 4500,
        priceMax: 8500,
        status: 'active',
        moderationStatus: 'approved',
        location: { district: 'Surat' },
        images: ['a.jpg'],
        createdAt: new Date(),
      };
      // 1st .find = id-only scan in searchListingsViaMongo; 2nd = hydration.
      let call = 0;
      listingModel.find = vi.fn(() => {
        call += 1;
        return chain(call === 1 ? [{ _id: id1 }] : [listingDoc]);
      });
      // Author-active gate (SRCH-LEAK-1): the owner's User row is active.
      userModel.find = vi.fn(() => chain([{ _id: ownerId }]));

      const result = await build().searchListings('zari');
      expect(result.listings).toHaveLength(1);
      expect(result.listings[0]?.title).toBe('Zari saree');
      // Mongo fallback always returns empty tagCounts.
      expect(result.tagCounts).toEqual({});
      expect(meili.multiSearch).not.toHaveBeenCalled();
    });

    it('Meili path: hydrates from Mongo, preserves rank order, drops missing rows', async () => {
      meili.enabled = true;
      const a = new Types.ObjectId();
      const b = new Types.ObjectId();
      meili.multiSearch = vi
        .fn()
        .mockResolvedValue([{ hits: [{ id: String(a) }, { id: String(b) }] }]);
      // Hydration returns `b` first; the service must reorder to put `a` first.
      const docA = { _id: a, title: 'A', status: 'active', moderationStatus: 'approved' };
      const docB = { _id: b, title: 'B', status: 'active', moderationStatus: 'approved' };
      listingModel.find = vi.fn(() => chain([docB, docA]));

      const result = await build().searchListings('zari');
      expect(result.listings.map((d) => d.title)).toEqual(['A', 'B']);
    });

    it('Meili path: surfaces tagCounts from facetDistribution', async () => {
      meili.enabled = true;
      const a = new Types.ObjectId();
      meili.multiSearch = vi.fn().mockResolvedValue([
        {
          hits: [{ id: String(a) }],
          facetDistribution: { tags: { kanjivaram: 5, zardozi: 3 }, category: { weaving: 2 } },
        },
      ]);
      listingModel.find = vi.fn(() =>
        chain([{ _id: a, title: 'A', status: 'active', moderationStatus: 'approved' }]),
      );

      const result = await build().searchListings('zari');
      expect(result.tagCounts).toEqual({ kanjivaram: 5, zardozi: 3 });
    });

    it('Meili path: tagCounts defaults to {} when no facetDistribution is returned', async () => {
      meili.enabled = true;
      const a = new Types.ObjectId();
      meili.multiSearch = vi.fn().mockResolvedValue([{ hits: [{ id: String(a) }] }]);
      listingModel.find = vi.fn(() =>
        chain([{ _id: a, title: 'A', status: 'active', moderationStatus: 'approved' }]),
      );

      const result = await build().searchListings('zari');
      expect(result.tagCounts).toEqual({});
    });

    // SECURITY (SRCH-LEAK-1 / SRCH-LEAK-4): author-active gate. A listing whose
    // owner was erased / banned (`isActive=false`) must be dropped at hydration,
    // even though the listing's own active+approved state survived the ban.
    it('drops a listing whose owner account was erased / banned (isActive=false)', async () => {
      const bannedOwner = new Types.ObjectId();
      const okOwner = new Types.ObjectId();
      const bannedListingId = new Types.ObjectId();
      const okListingId = new Types.ObjectId();
      const make = (id: Types.ObjectId, owner: Types.ObjectId, title: string) => ({
        _id: id,
        ownerUserId: owner,
        title,
        description: 'x',
        category: 'embroidery-zari',
        priceType: 'fixed',
        priceMin: 100,
        status: 'active',
        moderationStatus: 'approved',
        location: { district: 'Surat' },
        images: [],
        createdAt: new Date(),
      });
      let call = 0;
      listingModel.find = vi.fn(() => {
        call += 1;
        return chain(
          call === 1
            ? [{ _id: bannedListingId }, { _id: okListingId }]
            : [
                make(bannedListingId, bannedOwner, 'Banned shop'),
                make(okListingId, okOwner, 'Live shop'),
              ],
        );
      });
      // The author-active lookup returns ONLY the ok owner as active; the banned
      // owner is absent -> treated inactive -> their listing dropped.
      userModel.find = vi.fn(() => chain([{ _id: okOwner }]));

      const result = await build().searchListings('zari');

      expect(result.listings.map((l) => l.title)).toEqual(['Live shop']);
    });

    it('stamps the verified marker from the owner allowances (M2.3)', async () => {
      const id1 = new Types.ObjectId();
      const ownerId = new Types.ObjectId();
      const listingDoc = {
        _id: id1,
        ownerUserId: ownerId,
        title: 'Zari saree',
        description: 'Heavy work',
        category: 'embroidery-zari',
        priceType: 'fixed',
        priceMin: 4500,
        status: 'active',
        moderationStatus: 'approved',
        location: { district: 'Surat' },
        images: ['a.jpg'],
        createdAt: new Date(),
      };
      let call = 0;
      listingModel.find = vi.fn(() => {
        call += 1;
        return chain(call === 1 ? [{ _id: id1 }] : [listingDoc]);
      });
      // Author-active gate (SRCH-LEAK-1): the owner's User row is active.
      userModel.find = vi.fn(() => chain([{ _id: ownerId }]));
      allowanceService.getAllowances = vi.fn().mockResolvedValue({
        maxListings: -1,
        leadsPerMonth: -1,
        includedBoostCredits: 10,
        verifiedBadge: true,
        searchPriority: 5,
      });

      const result = await build().searchListings('zari');
      expect(result.listings[0]?.verified).toBe(true);
      expect(allowanceService.getAllowances).toHaveBeenCalledWith(String(ownerId));
    });
  });

  describe('indexListing', () => {
    it('is a no-op when Meili is disabled', async () => {
      await build().indexListing(new Types.ObjectId().toHexString());
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
      expect(meili.deleteDocument).not.toHaveBeenCalled();
      expect(listingModel.findById).not.toHaveBeenCalled();
    });

    it('ignores an invalid id without touching Meili', async () => {
      meili.enabled = true;
      await build().indexListing('not-an-objectid');
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
      expect(meili.deleteDocument).not.toHaveBeenCalled();
    });

    it('upserts an active + approved listing', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      listingModel.findById = vi.fn(() =>
        chain({
          _id: id,
          ownerUserId: new Types.ObjectId(),
          title: 'Zari work',
          description: 'Heavy',
          category: 'embroidery-zari',
          priceType: 'range',
          priceMin: 1000,
          priceMax: 5000,
          status: 'active',
          moderationStatus: 'approved',
          location: { district: 'Surat' },
          images: [],
          createdAt: new Date('2026-05-28T00:00:00Z'),
        }),
      );

      await build().indexListing(id);
      expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
      const [[, [doc]]] = meili.upsertDocuments.mock.calls;
      expect(doc.title).toBe('Zari work');
      expect(doc.district).toBe('surat');
      expect(meili.deleteDocument).not.toHaveBeenCalled();
    });

    it('deletes from the index when the listing is missing', async () => {
      meili.enabled = true;
      listingModel.findById = vi.fn(() => chain(null));

      await build().indexListing(new Types.ObjectId());
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('deletes from the index when the listing is non-public (paused / pending / rejected)', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      listingModel.findById = vi.fn(() =>
        chain({
          _id: id,
          status: 'paused',
          moderationStatus: 'approved',
          title: 'Zari',
          category: 'embroidery-zari',
          priceType: 'negotiable',
          ownerUserId: new Types.ObjectId(),
          location: {},
          images: [],
        }),
      );

      await build().indexListing(id);
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('deletes from the index when moderation is not approved', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      listingModel.findById = vi.fn(() =>
        chain({
          _id: id,
          status: 'active',
          moderationStatus: 'pending',
          title: 'Zari',
          category: 'embroidery-zari',
          priceType: 'negotiable',
          ownerUserId: new Types.ObjectId(),
          location: {},
          images: [],
        }),
      );

      await build().indexListing(id);
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });
  });

  describe('handleListingChanged', () => {
    it('re-indexes the listing id from the event payload', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      listingModel.findById = vi.fn(() => chain(null));

      await build().handleListingChanged({ listingId: id.toHexString() });
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('searchPosts (search redesign Phase B)', () => {
    it('returns [] for a blank query without touching the model', async () => {
      const result = await build().searchPosts('   ');
      expect(result).toEqual({ posts: [], total: 0 });
      expect(postModel.find).not.toHaveBeenCalled();
    });

    it('Mongo fallback: hydrates matched posts with their author', async () => {
      const p1 = new Types.ObjectId();
      const a1 = new Types.ObjectId();
      let call = 0;
      // 1st find = id-only scan; 2nd = the public-gated hydration.
      postModel.find = vi.fn(() => {
        call += 1;
        return chain(
          call === 1
            ? [{ _id: p1 }]
            : [
                {
                  _id: p1,
                  authorId: a1,
                  body: 'Heavy zari work',
                  kind: 'text',
                  media: [],
                  reactionCount: 2,
                  commentCount: 1,
                },
              ],
        );
      });
      connectProfileService.getPeopleByIds = vi
        .fn()
        .mockResolvedValue([
          { userId: String(a1), name: 'Meera', avatar: null, headline: 'Karigar' },
        ]);
      // Author-active gate (SRCH-LEAK-1): the post author's User row is active.
      userModel.find = vi.fn(() => chain([{ _id: a1 }]));

      const result = await build().searchPosts('zari');

      expect(connectProfileService.getPeopleByIds).toHaveBeenCalledWith([String(a1)]);
      expect(result.posts).toHaveLength(1);
      expect(result.posts[0].postId).toBe(String(p1));
      expect(result.posts[0].author?.name).toBe('Meera');
      expect(result.posts[0].snippet).toBe('Heavy zari work');
    });

    // SECURITY (SRCH-LEAK-1 / SRCH-LEAK-4): author-active gate on posts.
    it('drops a post whose author account was erased / banned (isActive=false)', async () => {
      const bannedPost = new Types.ObjectId();
      const okPost = new Types.ObjectId();
      const bannedAuthor = new Types.ObjectId();
      const okAuthor = new Types.ObjectId();
      let call = 0;
      postModel.find = vi.fn(() => {
        call += 1;
        return chain(
          call === 1
            ? [{ _id: bannedPost }, { _id: okPost }]
            : [
                {
                  _id: bannedPost,
                  authorId: bannedAuthor,
                  body: 'banned',
                  kind: 'text',
                  media: [],
                },
                { _id: okPost, authorId: okAuthor, body: 'live', kind: 'text', media: [] },
              ],
        );
      });
      // Only the ok author is active; the banned author is absent -> dropped.
      userModel.find = vi.fn(() => chain([{ _id: okAuthor }]));
      connectProfileService.getPeopleByIds = vi
        .fn()
        .mockResolvedValue([
          { userId: String(okAuthor), name: 'Live', avatar: null, headline: null },
        ]);

      const result = await build().searchPosts('zari');

      expect(result.posts.map((p) => p.postId)).toEqual([String(okPost)]);
      // The banned author must not even reach people hydration.
      expect(connectProfileService.getPeopleByIds).toHaveBeenCalledWith([String(okAuthor)]);
    });
  });

  describe('indexPost (search redesign Phase B)', () => {
    it('de-indexes a missing / non-public / repost post', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      postModel.findById = vi.fn(() => chain(null));
      await build().indexPost(id.toHexString());
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('upserts a public original post', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      postModel.findById = vi.fn(() =>
        chain({
          _id: id,
          authorId: new Types.ObjectId(),
          kind: 'text',
          body: 'hi',
          hashtags: [],
          visibility: 'public',
          deletedAt: null,
          repostOf: null,
          reactionCount: 0,
          commentCount: 0,
          repostCount: 0,
        }),
      );
      await build().indexPost(id.toHexString());
      expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
    });

    it('re-indexes the post id from the event payload', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      postModel.findById = vi.fn(() => chain(null));
      await build().handlePostChanged({ postId: id.toHexString(), change: 'deleted' });
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('searchJobs (Phase 5)', () => {
    it('returns [] for a blank query without a facet, never touching the model', async () => {
      const result = await build().searchJobs('   ');
      expect(result).toEqual({ jobs: [], total: 0 });
      expect(jobModel.find).not.toHaveBeenCalled();
    });

    it('Mongo fallback: pins status open and hydrates render-ready job cards', async () => {
      const j1 = new Types.ObjectId();
      const companyId = new Types.ObjectId();
      // Author-active gate (SRCH-LEAK-1): the owning company's User row is active.
      userModel.find = vi.fn(() => chain([{ _id: companyId }]));
      let call = 0;
      // 1st find = id-only scan (pins status: open); 2nd = the open-gated hydration.
      jobModel.find = vi.fn((query: any) => {
        call += 1;
        if (call === 1) {
          // the id scan carries the open pin
          expect(query.status).toBe('open');
          return chain([{ _id: j1 }]);
        }
        return chain([
          {
            _id: j1,
            companyUserId: companyId,
            companyPageId: null,
            title: 'Zari karigar wanted',
            description: 'Daily wage',
            category: 'embroidery-zari',
            wageType: 'daily',
            wageMin: 500,
            wageMax: 700,
            openings: 2,
            location: { district: 'Surat' },
            status: 'open',
            applicationsCount: 0,
            boostCampaignId: null,
          },
        ]);
      });

      const result = await build().searchJobs('zari');

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]._id).toBe(String(j1));
      expect(result.jobs[0].title).toBe('Zari karigar wanted');
      // The hydration query must re-pin status: open so a stale index row cannot
      // leak a closed job.
      const hydrationQuery = jobModel.find.mock.calls[1][0];
      expect(hydrationQuery.status).toBe('open');
    });

    // SECURITY (SRCH-LEAK-1 / SRCH-LEAK-4): author-active gate on jobs.
    it('drops a job whose owning company account was erased / banned (isActive=false)', async () => {
      const bannedJob = new Types.ObjectId();
      const okJob = new Types.ObjectId();
      const bannedCompany = new Types.ObjectId();
      const okCompany = new Types.ObjectId();
      const make = (id: Types.ObjectId, company: Types.ObjectId, title: string) => ({
        _id: id,
        companyUserId: company,
        companyPageId: null,
        title,
        description: 'x',
        category: 'embroidery-zari',
        wageType: 'daily',
        wageMin: 500,
        wageMax: 700,
        openings: 1,
        location: { district: 'Surat' },
        status: 'open',
        applicationsCount: 0,
        boostCampaignId: null,
      });
      let call = 0;
      jobModel.find = vi.fn(() => {
        call += 1;
        return chain(
          call === 1
            ? [{ _id: bannedJob }, { _id: okJob }]
            : [make(bannedJob, bannedCompany, 'Banned co'), make(okJob, okCompany, 'Live co')],
        );
      });
      // Only the ok company is active; the banned company is absent -> dropped.
      userModel.find = vi.fn(() => chain([{ _id: okCompany }]));

      const result = await build().searchJobs('zari');

      expect(result.jobs.map((j) => j.title)).toEqual(['Live co']);
    });

    it('searches the category facet alone (no free-text query)', async () => {
      jobModel.find = vi.fn(() => chain([]));
      await build().searchJobs('', { category: 'weaving' });
      expect(jobModel.find).toHaveBeenCalled();
      const idScanQuery = jobModel.find.mock.calls[0][0];
      expect(idScanQuery.category).toBe('weaving');
      expect(idScanQuery.status).toBe('open');
    });
  });

  describe('indexJob (Phase 5)', () => {
    it('de-indexes a missing job', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      jobModel.findById = vi.fn(() => chain(null));
      await build().indexJob(id.toHexString());
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('de-indexes a closed / filled job (only open jobs are searchable)', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      jobModel.findById = vi.fn(() =>
        chain({
          _id: id,
          title: 'x',
          category: 'weaving',
          companyUserId: new Types.ObjectId(),
          status: 'closed',
        }),
      );
      await build().indexJob(id.toHexString());
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
      expect(meili.upsertDocuments).not.toHaveBeenCalled();
    });

    it('upserts an open job', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      jobModel.findById = vi.fn(() =>
        chain({
          _id: id,
          title: 'Zari karigar',
          description: 'Daily wage',
          category: 'embroidery-zari',
          companyUserId: new Types.ObjectId(),
          companyPageId: null,
          location: { district: 'Surat' },
          status: 'open',
        }),
      );
      await build().indexJob(id.toHexString());
      expect(meili.upsertDocuments).toHaveBeenCalledTimes(1);
    });

    it('re-indexes the job id from the event payload', async () => {
      meili.enabled = true;
      const id = new Types.ObjectId();
      jobModel.findById = vi.fn(() => chain(null));
      await build().handleJobChanged({ jobId: id.toHexString(), change: 'closed' });
      expect(meili.deleteDocument).toHaveBeenCalledTimes(1);
    });
  });

  // ── SRCH-PERF-1 — short-TTL Meili engine cache ───────────────────────────
  //
  // The cache wraps ONLY the viewer-independent engine output (hit ids + facet
  // counts) on the Meili path. Hydration — the Mongo re-query, the LIVE
  // author-active gate (`inactiveOwnerIds`), and the owner-signal enrichment —
  // always runs over the (cached) ids, so a banned author is still dropped
  // within the same request even on a cache HIT. The Mongo fallback is never
  // cached (Meili is the engine the cache protects).
  describe('SRCH-PERF-1 — Meili engine cache', () => {
    /** A pass-through cache that records calls but always computes (cache miss). */
    function passthroughCache() {
      return {
        wrap: vi.fn((_ns: string, _parts: unknown, compute: () => Promise<unknown>) => compute()),
      };
    }

    /** Build a SearchService with the cache injected as the trailing optional arg. */
    function buildWithCache(cache: unknown) {
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
        undefined as never, // overLimit (@Optional)
        cache as never, // searchCache (@Optional)
      );
    }

    it('wraps the Meili PEOPLE id lookup in the cache (namespace "people")', async () => {
      meili = { enabled: true, multiSearch: vi.fn().mockResolvedValue([{ hits: [{ id: 'u1' }] }]) };
      connectProfileService.getPeopleByIds = vi.fn().mockResolvedValue([{ userId: 'u1' }]);
      const cache = passthroughCache();

      await buildWithCache(cache).searchPeople('meera');

      expect(cache.wrap).toHaveBeenCalledTimes(1);
      expect(cache.wrap.mock.calls[0][0]).toBe('people');
      expect(meili.multiSearch).toHaveBeenCalled(); // pass-through still computes
    });

    it('wraps the Meili LISTINGS / POSTS / JOBS id lookups in the cache', async () => {
      meili = { enabled: true, multiSearch: vi.fn().mockResolvedValue([{ hits: [] }]) };
      const cache = passthroughCache();

      const svc = buildWithCache(cache);
      await svc.searchListings('zari');
      await svc.searchPosts('zari');
      await svc.searchJobs('zari');

      const namespaces = cache.wrap.mock.calls.map((c) => c[0]);
      expect(namespaces).toEqual(['listings', 'posts', 'jobs']);
    });

    it('does NOT cache the Mongo fallback (Meili disabled)', async () => {
      meili = { enabled: false, multiSearch: vi.fn() };
      profileModel.find = vi.fn(() => chain([{ userId: new Types.ObjectId() }]));
      userModel.find = vi.fn(() => chain([]));
      const cache = passthroughCache();

      await buildWithCache(cache).searchPeople('zari');

      expect(cache.wrap).not.toHaveBeenCalled();
    });

    // THE security invariant for SRCH-PERF-1: cached engine ids must NOT bypass
    // the live author-active gate. A warm cache returns ids WITHOUT touching
    // Meili, yet a banned owner's listing is still dropped at hydration.
    it('a cache HIT still applies the live author-active gate at hydration', async () => {
      const bannedOwner = new Types.ObjectId();
      const okOwner = new Types.ObjectId();
      const bannedListingId = new Types.ObjectId();
      const okListingId = new Types.ObjectId();
      const mk = (id: Types.ObjectId, owner: Types.ObjectId, title: string) => ({
        _id: id,
        ownerUserId: owner,
        title,
        description: 'x',
        category: 'embroidery-zari',
        priceType: 'fixed',
        priceMin: 100,
        status: 'active',
        moderationStatus: 'approved',
        location: { district: 'Surat' },
        images: [],
        createdAt: new Date(),
      });

      meili = { enabled: true, multiSearch: vi.fn() };
      // Warm cache: returns the engine result (ids + counts) directly, never
      // calling compute — so Meili is NOT hit on this request.
      const cache = {
        wrap: vi.fn(() =>
          Promise.resolve({
            ids: [String(bannedListingId), String(okListingId)],
            total: 2,
            tagCounts: {},
            categoryCounts: {},
            districtCounts: {},
          }),
        ),
      };
      // Hydration returns both listings; the author-active lookup marks only the
      // ok owner active, so the banned owner's listing must be dropped.
      listingModel.find = vi.fn(() =>
        chain([
          mk(bannedListingId, bannedOwner, 'Banned shop'),
          mk(okListingId, okOwner, 'Live shop'),
        ]),
      );
      userModel.find = vi.fn(() => chain([{ _id: okOwner }]));

      const result = await buildWithCache(cache).searchListings('zari');

      expect(meili.multiSearch).not.toHaveBeenCalled(); // served from cache
      expect(result.listings.map((l) => l.title)).toEqual(['Live shop']); // banned dropped live
    });
  });
});
