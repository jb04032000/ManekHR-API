import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
import { FeedDiscoveryService } from '../feed-discovery.service';

function cand(id: Types.ObjectId, score: number, origin = 'trending') {
  return { post: { _id: id }, sourceScore: score, origin };
}
const ctx = { viewerId: new Types.ObjectId(), now: Date.now(), limit: 10, viewerSkills: [] };

describe('FeedDiscoveryService (Phase 7c)', () => {
  it('merges sources, dedups by post keeping the strongest score, sorts desc', async () => {
    const p1 = new Types.ObjectId();
    const p2 = new Types.ObjectId();
    const p3 = new Types.ObjectId();
    const sourceA = { key: 'a', fetch: vi.fn().mockResolvedValue([cand(p1, 5), cand(p2, 3)]) };
    const sourceB = { key: 'b', fetch: vi.fn().mockResolvedValue([cand(p1, 9, 'b'), cand(p3, 1)]) };
    const svc = new FeedDiscoveryService([sourceA, sourceB]);

    const out = await svc.getCandidates(ctx, new Set());

    expect(out.map((c) => String(c.post._id))).toEqual([String(p1), String(p2), String(p3)]);
    expect(out[0].sourceScore).toBe(9); // p1 kept its strongest score
  });

  it('drops excluded (already in-network) posts', async () => {
    const p1 = new Types.ObjectId();
    const p2 = new Types.ObjectId();
    const src = { key: 'a', fetch: vi.fn().mockResolvedValue([cand(p1, 5), cand(p2, 3)]) };
    const svc = new FeedDiscoveryService([src]);

    const out = await svc.getCandidates(ctx, new Set([String(p1)]));

    expect(out.map((c) => String(c.post._id))).toEqual([String(p2)]);
  });

  it('isolates a failing source — the rest still contribute', async () => {
    const p1 = new Types.ObjectId();
    const ok = { key: 'ok', fetch: vi.fn().mockResolvedValue([cand(p1, 5)]) };
    const bad = { key: 'bad', fetch: vi.fn().mockRejectedValue(new Error('boom')) };
    const svc = new FeedDiscoveryService([bad, ok]);

    const out = await svc.getCandidates(ctx, new Set());

    expect(out.map((c) => String(c.post._id))).toEqual([String(p1)]);
  });

  it('caches the candidate pool per viewer within the TTL, refetching after it', async () => {
    const p1 = new Types.ObjectId();
    const p2 = new Types.ObjectId();
    const src = { key: 'a', fetch: vi.fn().mockResolvedValue([cand(p1, 5), cand(p2, 3)]) };
    const svc = new FeedDiscoveryService([src]);
    const viewerId = new Types.ObjectId();
    const t0 = 1_000_000;

    // First page builds the pool (one source fan-out).
    await svc.getCandidates({ ...ctx, viewerId, now: t0 }, new Set());
    expect(src.fetch).toHaveBeenCalledTimes(1);

    // A second page 30s later (within the 60s TTL) reuses the cached pool — no
    // refetch — yet the per-page exclude still applies fresh (p1 dropped here).
    const warm = await svc.getCandidates(
      { ...ctx, viewerId, now: t0 + 30_000 },
      new Set([String(p1)]),
    );
    expect(src.fetch).toHaveBeenCalledTimes(1);
    expect(warm.map((c) => String(c.post._id))).toEqual([String(p2)]);

    // Past the TTL the pool is rebuilt.
    await svc.getCandidates({ ...ctx, viewerId, now: t0 + 61_000 }, new Set());
    expect(src.fetch).toHaveBeenCalledTimes(2);
  });

  it('caps to the limit', async () => {
    const src = {
      key: 'a',
      fetch: vi
        .fn()
        .mockResolvedValue([
          cand(new Types.ObjectId(), 5),
          cand(new Types.ObjectId(), 4),
          cand(new Types.ObjectId(), 3),
        ]),
    };
    const svc = new FeedDiscoveryService([src]);

    const out = await svc.getCandidates({ ...ctx, limit: 2 }, new Set());

    expect(out).toHaveLength(2);
  });
});
