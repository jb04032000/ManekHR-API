/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mutable mocked env so each test can flip the host before constructing the
// client (the client captures `host` at construction). `vi.hoisted` makes the
// object available to the hoisted `vi.mock` factory. Both this path and the
// source's `../../../config/env` resolve to src/config/env, so the mock applies.
const mockEnv = vi.hoisted(() => ({ meili: { host: 'http://meili.test', apiKey: 'test-key' } }));
vi.mock('../../../../config/env', () => ({ env: mockEnv }));
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { MeiliClient } from '../meili.client';

/**
 * Unit coverage for `MeiliClient.multiSearch` (S1.5) — the `/multi-search`
 * federation primitive. Exercises query-order alignment, the blank-query
 * no-op skip (a blank q with no filter would match the whole index), the
 * facet-only browse, the resilience contract (fault -> [] per slot, never
 * throws), and the disabled no-op. `fetch` is stubbed globally.
 */
describe('MeiliClient.multiSearch', () => {
  beforeEach(() => {
    mockEnv.meili.host = 'http://meili.test';
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Wrap a sync builder into a Promise so a thrown error becomes a rejection. */
  function stubFetch(impl: () => unknown) {
    const fetchMock = vi.fn(() => Promise.resolve().then(() => impl()));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  /** Build a Meili-style `Response` that resolves to the given JSON body. */
  function ok(body: unknown) {
    return { ok: true, text: () => Promise.resolve(JSON.stringify(body)) };
  }

  it('POSTs /multi-search and returns hits aligned to query order', async () => {
    const fetchMock = stubFetch(() =>
      ok({ results: [{ hits: [{ id: 'a' }] }, { hits: [{ id: 'b' }, { id: 'c' }] }] }),
    );
    const client = new MeiliClient();

    const out = await client.multiSearch([
      { indexUid: 'connect_people', q: 'zari', limit: 25 },
      { indexUid: 'connect_listings', q: 'zari', limit: 25 },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://meili.test/multi-search');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.queries).toHaveLength(2);
    expect(body.queries[0]).toMatchObject({ indexUid: 'connect_people', q: 'zari', limit: 25 });
    expect(out[0].hits).toEqual([{ id: 'a' }]);
    expect(out[1].hits).toEqual([{ id: 'b' }, { id: 'c' }]);
  });

  it('skips a blank-query no-filter slot without sending it, returns empty hits for that slot', async () => {
    const fetchMock = stubFetch(() => ok({ results: [{ hits: [{ id: 'a' }] }] }));
    const client = new MeiliClient();

    const out = await client.multiSearch([
      { indexUid: 'connect_people', q: 'zari', limit: 25 },
      { indexUid: 'connect_listings', q: '   ', limit: 25 }, // no q, no filter -> skipped
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.queries).toHaveLength(1); // only the real query is sent
    expect(body.queries[0].indexUid).toBe('connect_people');
    expect(out[0].hits).toEqual([{ id: 'a' }]);
    expect(out[1].hits).toEqual([]);
  });

  it('sends a blank query that carries a filter (facet-only browse)', async () => {
    const fetchMock = stubFetch(() => ok({ results: [{ hits: [{ id: 'a' }] }] }));
    const client = new MeiliClient();

    const out = await client.multiSearch([
      { indexUid: 'connect_people', q: '', limit: 25, filter: ['openToWork = true'] },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].filter).toEqual(['openToWork = true']);
    expect(out[0].hits).toEqual([{ id: 'a' }]);
  });

  it('forwards the facets field to the Meilisearch query body', async () => {
    const fetchMock = stubFetch(() =>
      ok({
        results: [
          {
            hits: [{ id: 'L1' }],
            facetDistribution: { tags: { kanjivaram: 5, zardozi: 3 }, category: { weaving: 2 } },
          },
        ],
      }),
    );
    const client = new MeiliClient();

    const out = await client.multiSearch([
      { indexUid: 'connect_listings', q: 'zari', limit: 25, facets: ['category', 'tags'] },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.queries[0].facets).toEqual(['category', 'tags']);
    expect(out[0].hits).toEqual([{ id: 'L1' }]);
    expect(out[0].facetDistribution).toEqual({
      tags: { kanjivaram: 5, zardozi: 3 },
      category: { weaving: 2 },
    });
  });

  it('omits the facets key from the body when the leg has no facets', async () => {
    const fetchMock = stubFetch(() => ok({ results: [{ hits: [{ id: 'a' }] }] }));
    const client = new MeiliClient();

    await client.multiSearch([{ indexUid: 'connect_people', q: 'zari', limit: 25 }]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.queries[0]).not.toHaveProperty('facets');
  });

  it('returns empty hits per query and never throws when Meili faults', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const client = new MeiliClient();

    const out = await client.multiSearch([
      { indexUid: 'connect_people', q: 'zari', limit: 25 },
      { indexUid: 'connect_listings', q: 'zari', limit: 25 },
    ]);

    expect(out[0].hits).toEqual([]);
    expect(out[1].hits).toEqual([]);
  });

  it('no-ops to empty hits per query when disabled (blank host)', async () => {
    mockEnv.meili.host = '';
    const fetchMock = stubFetch(() => ok({}));
    const client = new MeiliClient();

    const out = await client.multiSearch([{ indexUid: 'connect_people', q: 'zari', limit: 25 }]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out[0].hits).toEqual([]);
  });

  it('returns empty hits for every slot when all queries are no-ops (no HTTP)', async () => {
    const fetchMock = stubFetch(() => ok({}));
    const client = new MeiliClient();

    const out = await client.multiSearch([{ indexUid: 'connect_people', q: '  ', limit: 25 }]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out[0].hits).toEqual([]);
  });
});
