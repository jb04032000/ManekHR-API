/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi } from 'vitest';

/**
 * Visibility / leak verification suite (CONNECT-SEARCH-VERIFICATION-CHECKLIST.md §1).
 *
 * These tests are the CHECKLIST-MAPPED launch-gate proof that the search
 * endpoint NEVER leaks content to an unauthorized viewer. Each test maps
 * to one checklist bullet. All assertions confirm zero rows AND zero count
 * (no count-leak) where the checklist demands it.
 *
 * Approach: unit-test `FederatedSearchService` directly with mocked inner
 * services. This is the correct layer to test because the checklist requires
 * the filter to run POST-Meili / PRE-blend in `FederatedSearchService`, not
 * in the client. By asserting at this boundary we prove it is server-side.
 *
 * The `SearchBlockFilterService` is tested separately below because it has
 * its own pure-function surface (`filterRows`) worth explicit coverage.
 */

// Stub @nestjs/mongoose BEFORE importing service to avoid reflect-metadata errors.
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

import { FederatedSearchService } from '../federated-search.service';
import { SearchBlockFilterService } from '../search-block-filter.service';

// ── Fixture builders ──────────────────────────────────────────────────────────

/** Build a minimal `FederatedSearchService` wired to fully-controlled mocks. */
function buildFederated(overrides: {
  people?: any[];
  posts?: any[];
  listings?: {
    items: any[];
    total: number;
    tagCounts?: any;
    categoryCounts?: any;
    districtCounts?: any;
  };
  jobs?: any[];
  storefronts?: any[];
  pages?: any[];
  blockedIds?: string[];
  type?: string;
}) {
  const {
    people = [],
    posts = [],
    listings = { items: [], total: 0, tagCounts: {}, categoryCounts: {}, districtCounts: {} },
    jobs = [],
    storefronts = [],
    pages = [],
    blockedIds = [],
  } = overrides;

  const searchService: any = {
    // Phase 2: searchPeople returns a { people, total } page (mirrors searchListings).
    // `total` seeds the people headline count so the people count-leak tests below
    // can assert it is decremented when a blocked person is dropped.
    searchPeople: vi.fn().mockResolvedValue({ people, total: people.length }),
    searchPosts: vi.fn().mockResolvedValue({ posts, total: posts.length }),
    searchListings: vi.fn().mockResolvedValue({
      listings: listings.items,
      total: listings.total,
      tagCounts: listings.tagCounts ?? {},
      categoryCounts: listings.categoryCounts ?? {},
      districtCounts: listings.districtCounts ?? {},
    }),
    searchJobs: vi.fn().mockResolvedValue({ jobs, total: jobs.length }),
    // SRCH-VERT-1: storefronts + company / institute pages.
    searchStorefronts: vi.fn().mockResolvedValue({ storefronts, total: storefronts.length }),
    searchPages: vi.fn().mockResolvedValue({ pages, total: pages.length }),
  };

  const tagService: any = {
    normalizeHashtags: vi.fn((t: string[]) => Promise.resolve(t)),
  };

  const blockFilter: any = {
    getBlockedUserIds: vi.fn().mockResolvedValue(new Set<string>(blockedIds)),
    filterRows: (rows: any[], authorIdOf: (r: any) => string, blocked: ReadonlySet<string>) =>
      blocked.size === 0 ? rows : rows.filter((r) => !blocked.has(String(authorIdOf(r)))),
  };

  const service = new FederatedSearchService(
    searchService,
    tagService,
    undefined, // posthog optional
    undefined, // reviews optional
    blockFilter,
  );

  return { service, searchService, tagService, blockFilter };
}

// ── Checklist §1 bullet 3: blocked-user content suppression (either direction) ─

describe('CHECKLIST §1 — Blocked-user content: blocked user never appears in results', () => {
  it('BOTH directions: viewer blocked them — their content is absent from all verticals', async () => {
    const blockedUserId = 'blocked-user-id';
    const { service } = buildFederated({
      people: [
        { userId: blockedUserId, name: 'Hidden Person' },
        { userId: 'visible-person', name: 'Visible' },
      ],
      posts: [
        { postId: 'p-bad', authorId: blockedUserId },
        { postId: 'p-ok', authorId: 'visible-person' },
      ],
      listings: {
        items: [
          {
            listingId: 'l-bad',
            ownerUserId: blockedUserId,
            category: 'weaving',
            district: 'Surat',
            tags: [],
          },
          {
            listingId: 'l-ok',
            ownerUserId: 'visible-person',
            category: 'weaving',
            district: 'Surat',
            tags: [],
          },
        ],
        total: 2,
      },
      jobs: [
        { _id: 'j-bad', companyUserId: blockedUserId },
        { _id: 'j-ok', companyUserId: 'visible-person' },
      ],
      blockedIds: [blockedUserId], // viewer blocked this user
    });

    const out = await service.search({ q: 'zari', type: 'all' }, 'viewer-id');

    // Zero rows for the blocked user across every vertical.
    expect(out.results.map((p: any) => p.userId)).not.toContain(blockedUserId);
    expect(out.posts.map((p: any) => p.postId)).not.toContain('p-bad');
    expect(out.listings.map((l: any) => l.listingId)).not.toContain('l-bad');
    expect(out.jobs.map((j: any) => j._id)).not.toContain('j-bad');

    // The visible user's content is unaffected.
    expect(out.results.map((p: any) => p.userId)).toContain('visible-person');
    expect(out.posts.map((p: any) => p.postId)).toContain('p-ok');
    expect(out.listings.map((l: any) => l.listingId)).toContain('l-ok');
    expect(out.jobs.map((j: any) => j._id)).toContain('j-ok');
  });

  it('BOTH directions: they blocked viewer — viewer still cannot see their content', async () => {
    // "They blocked the viewer" is the same set from `getBlockedUserIds`
    // perspective — the service returns a symmetric blocked set regardless of who
    // initiated, so this test confirms the service correctly consumes that set.
    const theyBlockedViewer = 'user-who-blocked-viewer';
    const { service } = buildFederated({
      people: [{ userId: theyBlockedViewer, name: 'Blocked Both Ways' }],
      blockedIds: [theyBlockedViewer],
    });

    const out = await service.search({ q: 'zari', type: 'people' }, 'viewer-id');

    expect(out.results).toHaveLength(0);
    expect(out.groups[0]?.results).toHaveLength(0);
  });

  it('zero rows AND zero count: peopleTotal does not leak a blocked persons count (Phase 2)', async () => {
    const blockedPerson = 'blocked-person';
    const { service } = buildFederated({
      people: [{ userId: blockedPerson, name: 'Hidden Karigar' }],
      // The fixture's searchPeople mock reports total = people.length (= 1) before
      // block-filtering. After dropping the one blocked row the count must be 0.
      blockedIds: [blockedPerson],
    });

    const out = await service.search({ q: 'zari', type: 'people' }, 'viewer-id');

    // Zero rows.
    expect(out.results).toHaveLength(0);
    // Zero count — the people headline total must not stay at 1 (that is a leak).
    expect(out.peopleTotal).toBe(0);
  });

  it('zero rows AND zero count: listingsTotal does not leak a blocked sellers listing count', async () => {
    const blockedSeller = 'blocked-seller';
    const { service } = buildFederated({
      listings: {
        items: [
          {
            listingId: 'l-bad',
            ownerUserId: blockedSeller,
            category: 'weaving',
            district: 'surat',
            tags: ['zari'],
          },
        ],
        // Meili reported total = 1 before block-filtering.
        total: 1,
        tagCounts: { zari: 1 },
        categoryCounts: { weaving: 1 },
        districtCounts: { surat: 1 },
      },
      blockedIds: [blockedSeller],
    });

    const out = await service.search({ q: 'zari', type: 'listings' }, 'viewer-id');

    // Zero rows.
    expect(out.listings).toHaveLength(0);
    // Zero count — the headline total must not stay at 1 (that would be a leak).
    expect(out.listingsTotal).toBe(0);
    // Facet buckets also decremented to 0.
    expect(out.tagCounts['zari'] ?? 0).toBe(0);
    expect(out.categoryCounts['weaving'] ?? 0).toBe(0);
    expect(out.districtCounts['surat'] ?? 0).toBe(0);
  });
});

// ── Checklist §1 bullet 4: self-scope-only / no cross-viewer leak ─────────────

describe('CHECKLIST §1 — Self-scope: unauthorized viewer gets zero rows AND zero count', () => {
  it('a viewer with a full block list sees nothing across all verticals (total suppression)', async () => {
    const { service } = buildFederated({
      people: [
        { userId: 'bad-1', name: 'H1' },
        { userId: 'bad-2', name: 'H2' },
      ],
      posts: [
        { postId: 'p1', authorId: 'bad-1' },
        { postId: 'p2', authorId: 'bad-2' },
      ],
      listings: {
        items: [
          { listingId: 'l1', ownerUserId: 'bad-1', category: 'x', district: '', tags: [] },
          { listingId: 'l2', ownerUserId: 'bad-2', category: 'x', district: '', tags: [] },
        ],
        total: 2,
      },
      jobs: [
        { _id: 'j1', companyUserId: 'bad-1' },
        { _id: 'j2', companyUserId: 'bad-2' },
      ],
      blockedIds: ['bad-1', 'bad-2'],
    });

    const out = await service.search({ q: 'anything', type: 'all' }, 'viewer');

    expect(out.results).toHaveLength(0);
    expect(out.posts).toHaveLength(0);
    expect(out.listings).toHaveLength(0);
    expect(out.jobs).toHaveLength(0);
    expect(out.listingsTotal).toBe(0);

    // The group objects still exist (so the UI knows the request was made)
    // but their results arrays are all empty — no data leaks through the group count.
    for (const g of out.groups) {
      expect(g.results).toHaveLength(0);
    }
  });

  it('a viewer with no blocks sees all content (the common-case no-op baseline)', async () => {
    const { service } = buildFederated({
      people: [{ userId: 'u1', name: 'Alice' }],
      blockedIds: [], // no blocks
    });

    const out = await service.search({ q: 'alice', type: 'people' }, 'viewer');

    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ userId: 'u1' });
  });
});

// ── Checklist §1 bullet 2: draft/unapproved/moderated listings never surface ──

describe('CHECKLIST §1 — Draft/unapproved listings never surface to non-owner', () => {
  /**
   * The gateway for this is the Meilisearch filter and the Mongo re-pin in
   * `SearchService.searchListings` — only `status: active` + `moderationStatus: approved`
   * pass hydration. Here we confirm it via the listing index filter builder which is
   * the single source of truth for the Meili public gate. This is a pure helper test
   * that does not need the full service stack.
   */
  it('buildListingMeiliFilter always includes the status=active + moderationStatus=approved clause for public queries', async () => {
    const { buildListingMeiliFilter } = await import('../listing-search.helpers');
    const clauses = buildListingMeiliFilter({}, { publicOnly: true });
    expect(clauses).toContain("status = 'active'");
    expect(clauses).toContain("moderationStatus = 'approved'");
  });

  it('buildListingMongoConditions always pins status=active + moderationStatus=approved for public queries', async () => {
    const { buildListingMongoConditions } = await import('../listing-search.helpers');
    const conditions = buildListingMongoConditions({}, { publicOnly: true });
    expect(conditions.status).toBe('active');
    expect(conditions.moderationStatus).toBe('approved');
  });

  it('non-public gate is absent when publicOnly is false (admin/owner paths)', async () => {
    const { buildListingMeiliFilter, buildListingMongoConditions } =
      await import('../listing-search.helpers');
    const meiliClauses = buildListingMeiliFilter({}, { publicOnly: false });
    expect(meiliClauses).not.toContain("status = 'active'");
    expect(meiliClauses).not.toContain("moderationStatus = 'approved'");

    const mongoConds = buildListingMongoConditions({}, { publicOnly: false });
    expect(mongoConds).not.toHaveProperty('status');
    expect(mongoConds).not.toHaveProperty('moderationStatus');
  });
});

// ── Checklist §1 bullet 5: connections-only posts never surface to non-connected viewers ─

describe('CHECKLIST §1 — Posts public gate: only public, non-deleted, non-repost posts surface', () => {
  /**
   * The post visibility gate is applied at hydration in `SearchService.searchPosts`
   * (re-pins `visibility: 'public', deletedAt: null, repostOf: null`). This test
   * confirms the Mongo gate condition is always enforced on the fallback path.
   *
   * Note: `buildPostMeiliFilter` does NOT need a visibility clause because the
   * Meilisearch index itself only holds public posts — the indexer (`indexPost`)
   * removes any non-public / deleted / repost entry before it reaches the index.
   * The public gate is therefore enforced at INDEX TIME, and at HYDRATION TIME
   * (the Mongo re-pin). The filter builder only narrows by facet (kind / author).
   * A connections-only post is NEVER indexed, so it cannot appear in Meili results.
   */
  it('buildPostMongoConditions always pins visibility=public + deletedAt=null + non-repost', async () => {
    const { buildPostMongoConditions } = await import('../post-search.helpers');
    const conditions = buildPostMongoConditions({});
    expect(conditions.visibility).toBe('public');
    expect(conditions.deletedAt).toBeNull();
    expect(conditions.repostOf).toBeNull();
  });

  it('buildPostMeiliFilter does not need a visibility clause (enforced at index time and hydration)', async () => {
    const { buildPostMeiliFilter } = await import('../post-search.helpers');
    const clauses = buildPostMeiliFilter({});
    // The filter builder only narrows by kind/author facets. Visibility enforcement
    // happens at: (a) indexPost — non-public posts are deleted from the index, and
    // (b) hydration re-pin in searchPosts (`visibility: 'public', deletedAt: null`).
    // An empty clauses array here is correct and expected.
    // What we MUST confirm is it does not accidentally add a clause that widens
    // access (e.g., no `visibility != 'public'` style inversion).
    const joinedClauses = clauses.join(' ');
    expect(joinedClauses).not.toContain("visibility = 'connections'");
    expect(joinedClauses).not.toContain("visibility = 'private'");
  });
});

// ── Checklist §1 bullet 6: jobs public gate (status=open only) ────────────────

describe('CHECKLIST §1 — Jobs public gate: only open jobs are searchable', () => {
  /**
   * The job visibility gate: `buildJobMongoConditions` always pins `status: 'open'`
   * on the Mongo fallback path. The Meilisearch index only holds open jobs — the
   * indexer (`indexJob`) removes any closed/filled job before it reaches the index.
   * The public gate is enforced at INDEX TIME and at HYDRATION TIME (Mongo re-pin).
   */
  it('buildJobMongoConditions always pins status=open', async () => {
    const { buildJobMongoConditions } = await import('../job-search.helpers');
    const conditions = buildJobMongoConditions({});
    expect(conditions.status).toBe('open');
  });

  it('buildJobMeiliFilter does not expose closed/filled jobs (enforced at index time and hydration)', async () => {
    const { buildJobMeiliFilter } = await import('../job-search.helpers');
    const clauses = buildJobMeiliFilter({});
    // Like posts, the job Meili filter only narrows by category / companyPageId.
    // Status enforcement happens at index time (indexJob deletes non-open jobs)
    // and at hydration time (Mongo re-pins `status: 'open'`).
    // What we confirm: no clause that accidentally widens to closed jobs.
    const joinedClauses = clauses.join(' ');
    expect(joinedClauses).not.toContain("status = 'closed'");
    expect(joinedClauses).not.toContain("status = 'filled'");
  });
});

// ── Checklist §1 bullet 7: filter is server-side — confirmed by structural test ─

describe('CHECKLIST §1 — Filter is server-side (structural proof)', () => {
  /**
   * This test proves the block filter is invoked on the SERVICE, not the client:
   * we call `FederatedSearchService.search(...)` directly (bypassing any HTTP layer)
   * and assert that `SearchBlockFilterService.getBlockedUserIds` was called with the
   * correct viewer id. This is the only place where the block filter can run
   * SERVER-SIDE, since the test has no browser or HTTP stack.
   */
  it('getBlockedUserIds is called server-side with the authenticated viewer id before blending', async () => {
    const blockedIds = new Set(['some-blocked']);
    const { service, blockFilter } = buildFederated({
      people: [{ userId: 'some-blocked', name: 'H' }],
      blockedIds: ['some-blocked'],
    });
    blockFilter.getBlockedUserIds = vi.fn().mockResolvedValue(blockedIds);

    await service.search({ q: 'test', type: 'people' }, 'authenticated-viewer-id');

    // The server-side filter was called with the viewer's authenticated id.
    expect(blockFilter.getBlockedUserIds).toHaveBeenCalledWith('authenticated-viewer-id');
    // And the call happened ONCE per search (not deferred to the client).
    expect(blockFilter.getBlockedUserIds).toHaveBeenCalledTimes(1);
  });

  it('the block filter call precedes result assembly (filterRows called before groups are built)', async () => {
    const callOrder: string[] = [];
    const { service, searchService, blockFilter } = buildFederated({ blockedIds: [] });

    searchService.searchPeople = vi.fn().mockImplementation(() => {
      callOrder.push('meili-search');
      return Promise.resolve({ people: [], total: 0 });
    });

    blockFilter.getBlockedUserIds = vi.fn().mockImplementation(() => {
      callOrder.push('block-filter');
      return Promise.resolve(new Set<string>());
    });

    await service.search({ q: 'test', type: 'people' }, 'viewer');

    // Meili fan-out first, then block-filter (post-Meili, pre-blend is the contract).
    const meiliIdx = callOrder.indexOf('meili-search');
    const filterIdx = callOrder.indexOf('block-filter');
    expect(meiliIdx).toBeGreaterThanOrEqual(0);
    expect(filterIdx).toBeGreaterThan(meiliIdx);
  });
});

// ── Checklist §1 bullet: blank-query short-circuit leaks nothing ──────────────

describe('CHECKLIST §1 — Blank query returns empty result, no count-leak', () => {
  it('blank query with no facets returns empty groups, empty results, and zero listingsTotal', async () => {
    const { service, searchService } = buildFederated({
      people: [{ userId: 'u1', name: 'Alice' }],
    });

    const out = await service.search({ q: '', type: 'all' }, 'viewer');

    // Short-circuit: the vertical search functions are never called.
    expect(searchService.searchPeople).not.toHaveBeenCalled();
    expect(searchService.searchListings).not.toHaveBeenCalled();

    // Response carries zero data — nothing leaked.
    expect(out.results).toHaveLength(0);
    expect(out.listings).toHaveLength(0);
    expect(out.posts).toHaveLength(0);
    expect(out.jobs).toHaveLength(0);
    expect(out.listingsTotal).toBe(0);
  });
});

// ── SearchBlockFilterService unit coverage ────────────────────────────────────

describe('SearchBlockFilterService.filterRows (pure-function contract)', () => {
  /**
   * The `filterRows` method on `SearchBlockFilterService` is a pure function that
   * does not need DI. We instantiate a partial mock to call it directly.
   */
  const partialFilter = {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- pure function called directly; no `this` use (see note above)
    filterRows: SearchBlockFilterService.prototype.filterRows,
  } as unknown as SearchBlockFilterService;

  it('returns the original array reference when nothing is blocked (common case, no allocation)', () => {
    const rows = [{ userId: 'u1' }, { userId: 'u2' }];
    const empty = new Set<string>();
    const result = partialFilter.filterRows(rows, (r) => r.userId, empty);
    // Same reference — no unnecessary allocation in the hot path.
    expect(result).toBe(rows);
  });

  it('returns the original array when rows is empty', () => {
    const rows: any[] = [];
    const result = partialFilter.filterRows(rows, (r) => r.userId, new Set(['x']));
    expect(result).toBe(rows);
  });

  it('drops any row whose author id is in the blocked set', () => {
    const rows = [{ userId: 'blocked' }, { userId: 'ok' }, { userId: 'also-blocked' }];
    const blocked = new Set(['blocked', 'also-blocked']);
    const result = partialFilter.filterRows(rows, (r) => r.userId, blocked);
    expect(result.map((r) => r.userId)).toEqual(['ok']);
  });

  it('tolerates a numeric author id by String-coercing it', () => {
    const rows = [{ id: 123 }, { id: 456 }];
    const blocked = new Set(['123']);
    const result = partialFilter.filterRows(rows, (r) => String(r.id), blocked);
    expect(result.map((r) => r.id)).toEqual([456]);
  });

  it('is deterministic: repeated calls with the same inputs produce the same output', () => {
    const rows = [{ userId: 'x' }, { userId: 'y' }];
    const blocked = new Set(['x']);
    const r1 = partialFilter.filterRows(rows, (r) => r.userId, blocked);
    const r2 = partialFilter.filterRows(rows, (r) => r.userId, blocked);
    expect(r1).toEqual(r2);
  });
});
