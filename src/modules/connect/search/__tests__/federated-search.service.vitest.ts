/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing the service — it transitively pulls in
// SearchService and TagService, whose decorated schema imports would otherwise
// trip vitest's reflect-metadata pipeline.
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

import { FederatedSearchService } from '../federated-search.service';

/**
 * Unit coverage for `FederatedSearchService` (S1.5). The people vertical
 * (SearchService), the tag taxonomy (TagService), and PostHog are mocked: the
 * orchestrator is the unit under test — query understanding, alias->slug fold,
 * facet merge, group assembly, the blank-query short-circuit, and the search /
 * zero-result events.
 */
function build() {
  const searchService: any = {
    // Phase 2: searchPeople now returns a { people, total } page (mirrors searchListings).
    searchPeople: vi.fn().mockResolvedValue({ people: [], total: 0 }),
    searchPosts: vi.fn().mockResolvedValue({ posts: [], total: 0 }),
    searchListings: vi
      .fn()
      .mockResolvedValue({ listings: [], tagCounts: {}, categoryCounts: {}, districtCounts: {} }),
    searchJobs: vi.fn().mockResolvedValue({ jobs: [], total: 0 }),
    // SRCH-VERT-1: storefronts + company / institute pages.
    searchStorefronts: vi.fn().mockResolvedValue({ storefronts: [], total: 0 }),
    searchPages: vi.fn().mockResolvedValue({ pages: [], total: 0 }),
  };
  const tagService: any = {
    normalizeHashtags: vi.fn((tags: string[]) => Promise.resolve(tags)),
  };
  const posthog: any = { capture: vi.fn() };
  // No reviews module in unit scope; block-filter resolves an empty set by
  // default so the orchestration tests below are block-agnostic. The dedicated
  // block-suppression tests pass their own blocked set.
  const blockFilter: any = {
    getBlockedUserIds: vi.fn().mockResolvedValue(new Set<string>()),
    filterRows: (rows: any[], authorIdOf: (r: any) => string, blocked: ReadonlySet<string>) =>
      blocked.size === 0 ? rows : rows.filter((r) => !blocked.has(String(authorIdOf(r)))),
  };
  const service = new FederatedSearchService(
    searchService,
    tagService,
    posthog,
    undefined,
    blockFilter,
  );
  return { service, searchService, tagService, posthog, blockFilter };
}

describe('FederatedSearchService.search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves hashtags to canonical slugs and folds them into the people search text', async () => {
    const f = build();
    f.tagService.normalizeHashtags = vi.fn(() => Promise.resolve(['zari'])); // #zardozi -> zari
    await f.service.search({ q: '#zardozi designer' }, 'user-1');

    expect(f.tagService.normalizeHashtags).toHaveBeenCalledWith(['zardozi']);
    const [text] = f.searchService.searchPeople.mock.calls[0];
    expect(text).toContain('zari'); // canonical folded in for recall
    expect(text).toContain('zardozi'); // original kept
  });

  it('infers the open-to-work facet from the query phrase and strips it from the text', async () => {
    const f = build();
    await f.service.search({ q: 'zari open to work' }, 'user-1');

    const [text, facets] = f.searchService.searchPeople.mock.calls[0];
    expect(text).toBe('zari');
    expect(facets.openToWork).toBe(true);
  });

  it('merges explicit facet params with inferred intent', async () => {
    const f = build();
    await f.service.search({ q: 'open to work', skills: ['kundan'], district: 'Surat' }, 'user-1');

    const [, facets] = f.searchService.searchPeople.mock.calls[0];
    expect(facets.skills).toEqual(['kundan']);
    expect(facets.district).toBe('Surat');
    expect(facets.openToWork).toBe(true);
  });

  it('returns the people results as both the primary list and the people group', async () => {
    const f = build();
    const people = [{ userId: 'u1', name: 'Asha' }];
    f.searchService.searchPeople = vi.fn().mockResolvedValue({ people, total: people.length });

    const out = await f.service.search({ q: 'asha' }, 'user-1');

    expect(out.results).toEqual(people);
    expect(out.listings).toEqual([]);
    expect(out.groups).toEqual([{ type: 'people', results: people }]);
    expect(out.type).toBe('people');
    // Phase 2: the people total flows through to the envelope.
    expect(out.peopleTotal).toBe(people.length);
    expect(out.query.tags).toEqual([]);
    // Default `type=people` does not fan out to listings.
    expect(f.searchService.searchListings).not.toHaveBeenCalled();
  });

  // M1.4.2 - listings vertical + federated fan-out.

  it('fans out to listings when type=listings, omits the people leg', async () => {
    const f = build();
    const listings = [{ listingId: 'L1', title: 'Zari saree' }];
    f.searchService.searchListings = vi
      .fn()
      .mockResolvedValue({ listings, tagCounts: {}, categoryCounts: {}, districtCounts: {} });

    const out = await f.service.search({ q: 'zari', type: 'listings' }, 'user-1');

    expect(f.searchService.searchPeople).not.toHaveBeenCalled();
    // Third arg is the listings page; undefined for non-paged (typeahead /
    // search-page) callers so searchListings keeps its own default. The
    // marketplace passes { limit, offset } explicitly.
    expect(f.searchService.searchListings).toHaveBeenCalledWith('zari', {}, undefined);
    expect(out.results).toEqual([]);
    expect(out.listings).toEqual(listings);
    expect(out.groups).toEqual([{ type: 'listings', results: listings }]);
    expect(out.type).toBe('listings');
  });

  it('fans out to both verticals when type=all, ordered people first by weight', async () => {
    const f = build();
    const people = [{ userId: 'u1', name: 'Asha' }];
    const listings = [{ listingId: 'L1', title: 'Zari saree' }];
    f.searchService.searchPeople = vi.fn().mockResolvedValue({ people, total: people.length });
    f.searchService.searchListings = vi
      .fn()
      .mockResolvedValue({ listings, tagCounts: {}, categoryCounts: {}, districtCounts: {} });

    const out = await f.service.search({ q: 'zari', type: 'all' }, 'user-1');

    expect(f.searchService.searchPeople).toHaveBeenCalledTimes(1);
    expect(f.searchService.searchListings).toHaveBeenCalledTimes(1);
    expect(out.results).toEqual(people);
    expect(out.listings).toEqual(listings);
    // Verticals sit by weight (people 100 > posts 90 > listings 80 > jobs 75 >
    // pages 70 > storefronts 65). The other legs run (query present) but the mocks
    // return none, so they are empty groups (SRCH-VERT-1 added pages + storefronts).
    expect(out.groups).toEqual([
      { type: 'people', results: people },
      { type: 'posts', results: [] },
      { type: 'listings', results: listings },
      { type: 'jobs', results: [] },
      { type: 'pages', results: [] },
      { type: 'storefronts', results: [] },
    ]);
    expect(out.type).toBe('all');
  });

  it('queries only posts when type=posts (search redesign Phase B)', async () => {
    const f = build();
    const posts = [
      {
        postId: 'p1',
        authorId: 'u1',
        snippet: 'zari',
        kind: 'text',
        author: { userId: 'u1', name: 'Asha' },
      },
    ];
    f.searchService.searchPosts = vi.fn().mockResolvedValue({ posts, total: posts.length });

    const out = await f.service.search({ q: 'zari', type: 'posts' }, 'user-1');

    expect(f.searchService.searchPosts).toHaveBeenCalledWith('zari', {}, undefined);
    expect(f.searchService.searchPeople).not.toHaveBeenCalled();
    expect(f.searchService.searchListings).not.toHaveBeenCalled();
    expect(out.posts).toEqual(posts);
    expect(out.groups).toEqual([{ type: 'posts', results: posts }]);
  });

  it('forwards the posts content-kind facet to searchPosts', async () => {
    const f = build();
    await f.service.search({ q: 'zari', type: 'posts', kind: 'photo' }, 'user-1');
    expect(f.searchService.searchPosts).toHaveBeenCalledWith('zari', { kind: 'photo' }, undefined);
  });

  it('runs a posts kind-only browse with a blank query', async () => {
    const f = build();
    await f.service.search({ type: 'posts', kind: 'video' }, 'user-1');
    expect(f.searchService.searchPosts).toHaveBeenCalledWith('', { kind: 'video' }, undefined);
  });

  it('forwards listing-only facets (category, priceMin, priceMax) to searchListings', async () => {
    const f = build();

    await f.service.search(
      {
        q: '',
        type: 'listings',
        category: 'embroidery-zari',
        priceMin: 1000,
        priceMax: 5000,
        district: 'Surat',
      },
      'user-1',
    );

    expect(f.searchService.searchListings).toHaveBeenCalledWith(
      '',
      {
        category: 'embroidery-zari',
        priceMin: 1000,
        priceMax: 5000,
        district: 'Surat',
      },
      undefined,
    );
  });

  it('short-circuits the blank facet-less listings query without touching either backend', async () => {
    const f = build();
    const out = await f.service.search({ type: 'listings' }, 'user-1');

    expect(f.searchService.searchPeople).not.toHaveBeenCalled();
    expect(f.searchService.searchListings).not.toHaveBeenCalled();
    expect(out.results).toEqual([]);
    expect(out.listings).toEqual([]);
    expect(out.groups).toEqual([{ type: 'listings', results: [] }]);
    expect(out.type).toBe('listings');
  });

  it('runs the listings leg when only a listing facet is set, even with a blank q', async () => {
    const f = build();
    f.searchService.searchListings = vi
      .fn()
      .mockResolvedValue({ listings: [], tagCounts: {}, categoryCounts: {}, districtCounts: {} });

    await f.service.search({ type: 'listings', category: 'weaving' }, 'user-1');

    expect(f.searchService.searchListings).toHaveBeenCalledWith(
      '',
      { category: 'weaving' },
      undefined,
    );
  });

  it('emits search_performed and, on no hits, search_no_results carrying the term', async () => {
    const f = build();
    f.searchService.searchPeople = vi.fn().mockResolvedValue({ people: [], total: 0 });

    await f.service.search({ q: 'tarkashi' }, 'user-9');

    const events = f.posthog.capture.mock.calls.map((c: any) => c[0].event);
    expect(events).toContain('connect.search_performed');
    expect(events).toContain('connect.search_no_results');
    const zero = f.posthog.capture.mock.calls.find(
      (c: any) => c[0].event === 'connect.search_no_results',
    )[0];
    expect(zero.distinctId).toBe('user-9');
    expect(zero.properties.query).toBe('tarkashi');
  });

  it('does NOT emit a no-results event when there are hits', async () => {
    const f = build();
    f.searchService.searchPeople = vi
      .fn()
      .mockResolvedValue({ people: [{ userId: 'u1' }], total: 1 });

    await f.service.search({ q: 'zari' }, 'user-1');

    const events = f.posthog.capture.mock.calls.map((c: any) => c[0].event);
    expect(events).toContain('connect.search_performed');
    expect(events).not.toContain('connect.search_no_results');
  });

  it('short-circuits a blank query with no facets: no search, no events', async () => {
    const f = build();

    const out = await f.service.search({ q: '   ' }, 'user-1');

    expect(f.searchService.searchPeople).not.toHaveBeenCalled();
    expect(f.posthog.capture).not.toHaveBeenCalled();
    expect(out.results).toEqual([]);
    expect(out.groups).toEqual([{ type: 'people', results: [] }]);
  });

  // Wave 1: blocked-user suppression (APPROVED visibility-contract change).
  // The filter runs post-Meili / pre-blend on EVERY vertical by author id, so a
  // blocked author is absent from the response AND uncounted.

  it('drops people authored by a blocked user (either direction) and uncounts them', async () => {
    const f = build();
    const people = [
      { userId: 'blocked-u', name: 'Hidden' },
      { userId: 'ok-u', name: 'Visible' },
    ];
    f.searchService.searchPeople = vi.fn().mockResolvedValue({ people, total: people.length });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked-u']));

    const out = await f.service.search({ q: 'asha', type: 'people' }, 'viewer-1');

    expect(f.blockFilter.getBlockedUserIds).toHaveBeenCalledWith('viewer-1');
    expect(out.results.map((p: any) => p.userId)).toEqual(['ok-u']);
    expect(out.groups).toEqual([
      { type: 'people', results: [{ userId: 'ok-u', name: 'Visible' }] },
    ]);
  });

  it('drops blocked authors across EVERY vertical (people / posts / listings / jobs)', async () => {
    const f = build();
    f.searchService.searchPeople = vi.fn().mockResolvedValue({
      people: [
        { userId: 'bad', name: 'P' },
        { userId: 'good', name: 'Q' },
      ],
      total: 2,
    });
    f.searchService.searchPosts = vi.fn().mockResolvedValue({
      posts: [
        { postId: 'p1', authorId: 'bad' },
        { postId: 'p2', authorId: 'good' },
      ],
      total: 2,
    });
    f.searchService.searchListings = vi.fn().mockResolvedValue({
      listings: [
        { listingId: 'l1', ownerUserId: 'bad' },
        { listingId: 'l2', ownerUserId: 'good' },
      ],
      total: 2,
      tagCounts: {},
      categoryCounts: {},
      districtCounts: {},
    });
    f.searchService.searchJobs = vi.fn().mockResolvedValue({
      jobs: [
        { _id: 'j1', companyUserId: 'bad' },
        { _id: 'j2', companyUserId: 'good' },
      ],
      total: 2,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['bad']));

    const out = await f.service.search({ q: 'zari', type: 'all' }, 'viewer-1');

    expect(out.results.map((p: any) => p.userId)).toEqual(['good']);
    expect(out.posts.map((p: any) => p.postId)).toEqual(['p2']);
    expect(out.listings.map((l: any) => l.listingId)).toEqual(['l2']);
    expect(out.jobs.map((j: any) => j._id)).toEqual(['j2']);
  });

  it('is a no-op when the viewer has no blocks', async () => {
    const f = build();
    const people = [{ userId: 'u1', name: 'Asha' }];
    f.searchService.searchPeople = vi.fn().mockResolvedValue({ people, total: people.length });

    const out = await f.service.search({ q: 'asha' }, 'viewer-1');

    expect(out.results).toEqual(people);
  });

  it('tolerates an absent PostHog (optional dependency)', async () => {
    const searchService: any = {
      searchPeople: vi.fn().mockResolvedValue({ people: [], total: 0 }),
    };
    const tagService: any = {
      normalizeHashtags: vi.fn((t: string[]) => Promise.resolve(t)),
    };
    // SRCH-LEAK-3: the block filter is now REQUIRED (not @Optional), so it must
    // always be constructed — a missing security filter must fail at construction
    // time, never silently fail-open. PostHog (3rd arg) + reviews (4th arg) stay
    // optional.
    const blockFilter: any = {
      getBlockedUserIds: vi.fn().mockResolvedValue(new Set<string>()),
      filterRows: (rows: any[]) => rows,
    };
    const service = new FederatedSearchService(
      searchService,
      tagService,
      undefined,
      undefined,
      blockFilter,
    );

    await expect(service.search({ q: 'zari' }, 'user-1')).resolves.toBeDefined();
  });

  // SRCH-LEAK-2: count-leak. A blocked seller's listing must be dropped from the
  // page AND shrink listingsTotal (the web infinite-scroll hasMore) + its facet
  // buckets — "zero rows AND a zero count".
  it('shrinks listingsTotal (and facet buckets) when a blocked seller listing is dropped', async () => {
    const f = build();
    f.searchService.searchListings = vi.fn().mockResolvedValue({
      listings: [
        {
          listingId: 'l1',
          ownerUserId: 'blocked',
          category: 'weaving',
          district: 'Surat',
          tags: ['zari'],
        },
        {
          listingId: 'l2',
          ownerUserId: 'ok',
          category: 'weaving',
          district: 'Surat',
          tags: ['zari'],
        },
      ],
      // Corpus-wide total + facets straight from Meili (include the blocked row).
      total: 5,
      tagCounts: { zari: 5 },
      categoryCounts: { weaving: 5 },
      districtCounts: { surat: 5 },
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'listings' }, 'viewer-1');

    // Row dropped.
    expect(out.listings.map((l: any) => l.listingId)).toEqual(['l2']);
    // Headline total decremented by the one dropped page row (5 -> 4), never
    // below the visible array length (1).
    expect(out.listingsTotal).toBe(4);
    // Facet buckets decremented for the dropped listing's tag/category/district.
    expect(out.tagCounts.zari).toBe(4);
    expect(out.categoryCounts.weaving).toBe(4);
    expect(out.districtCounts.surat).toBe(4);
  });

  it('never lets the leak-corrected listingsTotal fall below the visible page length', async () => {
    const f = build();
    f.searchService.searchListings = vi.fn().mockResolvedValue({
      listings: [
        {
          listingId: 'l1',
          ownerUserId: 'blocked',
          category: 'weaving',
          district: 'Surat',
          tags: [],
        },
        { listingId: 'l2', ownerUserId: 'ok', category: 'weaving', district: 'Surat', tags: [] },
      ],
      // Total already equals the page (e.g. last page); after dropping 1, the
      // total must not dip under the 1 still-visible row.
      total: 2,
      tagCounts: {},
      categoryCounts: {},
      districtCounts: {},
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'listings' }, 'viewer-1');

    expect(out.listings).toHaveLength(1);
    expect(out.listingsTotal).toBe(1); // max(2 - 1, 1) === 1
  });

  // Phase 2 (progressive loading): the SAME count-leak accounting on the people
  // vertical — a blocked person is dropped from the page AND shrinks peopleTotal
  // (the web people-tab infinite-scroll hasMore source), never leaking a count.
  it('shrinks peopleTotal when a blocked person is dropped (count-leak parity with listings)', async () => {
    const f = build();
    f.searchService.searchPeople = vi.fn().mockResolvedValue({
      people: [
        { userId: 'blocked', name: 'Hidden' },
        { userId: 'ok', name: 'Visible' },
      ],
      // Meili reported corpus total = 9 (includes the blocked row's count).
      total: 9,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'people' }, 'viewer-1');

    // Row dropped.
    expect(out.results.map((p: any) => p.userId)).toEqual(['ok']);
    // Headline total decremented by the one dropped page row (9 -> 8), never
    // below the visible array length.
    expect(out.peopleTotal).toBe(8);
  });

  it('never lets the leak-corrected peopleTotal fall below the visible page length', async () => {
    const f = build();
    f.searchService.searchPeople = vi.fn().mockResolvedValue({
      people: [
        { userId: 'blocked', name: 'Hidden' },
        { userId: 'ok', name: 'Visible' },
      ],
      // Total already equals the page; after dropping 1 it must not dip under 1.
      total: 2,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'people' }, 'viewer-1');

    expect(out.results).toHaveLength(1);
    expect(out.peopleTotal).toBe(1); // max(2 - 1, 1) === 1
  });

  it('threads the active-vertical page (limit/offset) into searchPeople only on the focused people tab', async () => {
    const f = build();
    f.searchService.searchPeople = vi.fn().mockResolvedValue({ people: [], total: 0 });

    await f.service.search({ q: 'zari', type: 'people', limit: 24, offset: 48 }, 'viewer-1');

    expect(f.searchService.searchPeople).toHaveBeenCalledWith('zari', expect.any(Object), {
      limit: 24,
      offset: 48,
    });
  });

  it('does NOT page the people preview on the blended all tab (page stays undefined)', async () => {
    const f = build();
    f.searchService.searchPeople = vi.fn().mockResolvedValue({ people: [], total: 0 });

    // Even if a limit leaks onto a type=all request, the blended people preview
    // must not paginate (Phase 1b keeps it a preview; only the focused tab pages).
    await f.service.search({ q: 'zari', type: 'all', limit: 24, offset: 0 }, 'viewer-1');

    const callArgs = f.searchService.searchPeople.mock.calls[0];
    expect(callArgs[2]).toBeUndefined();
  });

  // Phase 3 (progressive loading): the SAME count-leak accounting + page threading
  // on the posts vertical (the web posts-tab infinite-scroll hasMore source).
  it('shrinks postsTotal when a blocked author is dropped (count-leak parity)', async () => {
    const f = build();
    f.searchService.searchPosts = vi.fn().mockResolvedValue({
      posts: [
        { postId: 'blocked', authorId: 'blocked' },
        { postId: 'ok', authorId: 'ok' },
      ],
      // Engine reported corpus total = 9 (includes the blocked row's count).
      total: 9,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'posts' }, 'viewer-1');

    expect(out.posts.map((p: any) => p.postId)).toEqual(['ok']);
    expect(out.postsTotal).toBe(8); // 9 - 1 dropped, never below the visible length
  });

  it('never lets the leak-corrected postsTotal fall below the visible page length', async () => {
    const f = build();
    f.searchService.searchPosts = vi.fn().mockResolvedValue({
      posts: [
        { postId: 'blocked', authorId: 'blocked' },
        { postId: 'ok', authorId: 'ok' },
      ],
      total: 2,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'posts' }, 'viewer-1');

    expect(out.posts).toHaveLength(1);
    expect(out.postsTotal).toBe(1); // max(2 - 1, 1) === 1
  });

  it('threads the active-vertical page into searchPosts only on the focused posts tab', async () => {
    const f = build();
    f.searchService.searchPosts = vi.fn().mockResolvedValue({ posts: [], total: 0 });

    await f.service.search({ q: 'zari', type: 'posts', limit: 24, offset: 48 }, 'viewer-1');

    expect(f.searchService.searchPosts).toHaveBeenCalledWith('zari', expect.any(Object), {
      limit: 24,
      offset: 48,
    });
  });

  it('does NOT page the posts preview on the blended all tab (page stays undefined)', async () => {
    const f = build();
    f.searchService.searchPosts = vi.fn().mockResolvedValue({ posts: [], total: 0 });

    await f.service.search({ q: 'zari', type: 'all', limit: 24, offset: 0 }, 'viewer-1');

    const callArgs = f.searchService.searchPosts.mock.calls[0];
    expect(callArgs[2]).toBeUndefined();
  });

  // Phase 3: the SAME count-leak accounting + page threading on the jobs vertical
  // (the web jobs-tab infinite-scroll hasMore source).
  it('shrinks jobsTotal when a blocked employer is dropped (count-leak parity)', async () => {
    const f = build();
    f.searchService.searchJobs = vi.fn().mockResolvedValue({
      jobs: [
        { _id: 'blocked', companyUserId: 'blocked' },
        { _id: 'ok', companyUserId: 'ok' },
      ],
      total: 9,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'jobs' }, 'viewer-1');

    expect(out.jobs.map((j: any) => j._id)).toEqual(['ok']);
    expect(out.jobsTotal).toBe(8); // 9 - 1 dropped, never below the visible length
  });

  it('never lets the leak-corrected jobsTotal fall below the visible page length', async () => {
    const f = build();
    f.searchService.searchJobs = vi.fn().mockResolvedValue({
      jobs: [
        { _id: 'blocked', companyUserId: 'blocked' },
        { _id: 'ok', companyUserId: 'ok' },
      ],
      total: 2,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'jobs' }, 'viewer-1');

    expect(out.jobs).toHaveLength(1);
    expect(out.jobsTotal).toBe(1); // max(2 - 1, 1) === 1
  });

  it('threads the active-vertical page into searchJobs only on the focused jobs tab', async () => {
    const f = build();
    f.searchService.searchJobs = vi.fn().mockResolvedValue({ jobs: [], total: 0 });

    await f.service.search({ q: 'zari', type: 'jobs', limit: 24, offset: 48 }, 'viewer-1');

    expect(f.searchService.searchJobs).toHaveBeenCalledWith('zari', expect.any(Object), {
      limit: 24,
      offset: 48,
    });
  });

  it('does NOT page the jobs preview on the blended all tab (page stays undefined)', async () => {
    const f = build();
    f.searchService.searchJobs = vi.fn().mockResolvedValue({ jobs: [], total: 0 });

    await f.service.search({ q: 'zari', type: 'all', limit: 24, offset: 0 }, 'viewer-1');

    const callArgs = f.searchService.searchJobs.mock.calls[0];
    expect(callArgs[2]).toBeUndefined();
  });

  // Phase 3: the SAME count-leak accounting + page threading on the storefronts vertical.
  it('shrinks storefrontsTotal when a blocked owner is dropped (count-leak parity)', async () => {
    const f = build();
    f.searchService.searchStorefronts = vi.fn().mockResolvedValue({
      storefronts: [
        { storefrontId: 'blocked', ownerUserId: 'blocked' },
        { storefrontId: 'ok', ownerUserId: 'ok' },
      ],
      total: 9,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'storefronts' }, 'viewer-1');

    expect(out.storefronts.map((s: any) => s.storefrontId)).toEqual(['ok']);
    expect(out.storefrontsTotal).toBe(8); // 9 - 1 dropped, never below the visible length
  });

  it('never lets the leak-corrected storefrontsTotal fall below the visible page length', async () => {
    const f = build();
    f.searchService.searchStorefronts = vi.fn().mockResolvedValue({
      storefronts: [
        { storefrontId: 'blocked', ownerUserId: 'blocked' },
        { storefrontId: 'ok', ownerUserId: 'ok' },
      ],
      total: 2,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'storefronts' }, 'viewer-1');

    expect(out.storefronts).toHaveLength(1);
    expect(out.storefrontsTotal).toBe(1); // max(2 - 1, 1) === 1
  });

  it('threads the active-vertical page into searchStorefronts only on the focused storefronts tab', async () => {
    const f = build();
    f.searchService.searchStorefronts = vi.fn().mockResolvedValue({ storefronts: [], total: 0 });

    await f.service.search({ q: 'zari', type: 'storefronts', limit: 24, offset: 48 }, 'viewer-1');

    expect(f.searchService.searchStorefronts).toHaveBeenCalledWith('zari', expect.any(Object), {
      limit: 24,
      offset: 48,
    });
  });

  it('does NOT page the storefronts preview on the blended all tab (page stays undefined)', async () => {
    const f = build();
    f.searchService.searchStorefronts = vi.fn().mockResolvedValue({ storefronts: [], total: 0 });

    await f.service.search({ q: 'zari', type: 'all', limit: 24, offset: 0 }, 'viewer-1');

    const callArgs = f.searchService.searchStorefronts.mock.calls[0];
    expect(callArgs[2]).toBeUndefined();
  });

  // Phase 3: the SAME count-leak accounting + page threading on the pages vertical.
  it('shrinks pagesTotal when a blocked owner is dropped (count-leak parity)', async () => {
    const f = build();
    f.searchService.searchPages = vi.fn().mockResolvedValue({
      pages: [
        { pageId: 'blocked', ownerUserId: 'blocked' },
        { pageId: 'ok', ownerUserId: 'ok' },
      ],
      total: 9,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'pages' }, 'viewer-1');

    expect(out.pages.map((p: any) => p.pageId)).toEqual(['ok']);
    expect(out.pagesTotal).toBe(8); // 9 - 1 dropped, never below the visible length
  });

  it('never lets the leak-corrected pagesTotal fall below the visible page length', async () => {
    const f = build();
    f.searchService.searchPages = vi.fn().mockResolvedValue({
      pages: [
        { pageId: 'blocked', ownerUserId: 'blocked' },
        { pageId: 'ok', ownerUserId: 'ok' },
      ],
      total: 2,
    });
    f.blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(new Set(['blocked']));

    const out = await f.service.search({ q: 'zari', type: 'pages' }, 'viewer-1');

    expect(out.pages).toHaveLength(1);
    expect(out.pagesTotal).toBe(1); // max(2 - 1, 1) === 1
  });

  it('threads the active-vertical page into searchPages only on the focused pages tab', async () => {
    const f = build();
    f.searchService.searchPages = vi.fn().mockResolvedValue({ pages: [], total: 0 });

    await f.service.search({ q: 'zari', type: 'pages', limit: 24, offset: 48 }, 'viewer-1');

    expect(f.searchService.searchPages).toHaveBeenCalledWith('zari', expect.any(Object), {
      limit: 24,
      offset: 48,
    });
  });

  it('does NOT page the pages preview on the blended all tab (page stays undefined)', async () => {
    const f = build();
    f.searchService.searchPages = vi.fn().mockResolvedValue({ pages: [], total: 0 });

    await f.service.search({ q: 'zari', type: 'all', limit: 24, offset: 0 }, 'viewer-1');

    const callArgs = f.searchService.searchPages.mock.calls[0];
    expect(callArgs[2]).toBeUndefined();
  });
});
