import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { BannerService } from '../banner.service';

/**
 * Builds a mongoose-query-like chain: find().sort().lean().exec() -> docs.
 * Captures the filter passed to find() so we can assert it.
 */
function makeModel(docs: unknown[]) {
  const query = {
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(docs),
  };
  const find = vi.fn().mockReturnValue(query);
  return { model: { find } as never, find, query };
}

// PrivateMediaService stub: faithful signMany + resolve (map lookup, else raw).
const resolve = (v: string, m: Map<string, string>) => m.get(v) ?? v;
const media = {
  signMany: vi.fn().mockResolvedValue(new Map<string, string>()),
  resolve,
} as never;
const audit = { logEvent: vi.fn().mockResolvedValue(undefined) } as never;

const NOW = new Date('2026-07-03T12:00:00.000Z');
const past = (m: number) => new Date(NOW.getTime() - m * 60_000);
const future = (m: number) => new Date(NOW.getTime() + m * 60_000);

function banner(over: Record<string, unknown>) {
  return {
    _id: new Types.ObjectId(),
    imageUrl: 'https://cdn.example.com/a.jpg',
    linkUrl: '',
    title: 'Promo',
    alt: '',
    order: 0,
    isActive: true,
    liveFrom: null,
    liveUntil: null,
    ...over,
  };
}

describe('BannerService.listActive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] when there are no banners (empty -> hidden)', async () => {
    const { model } = makeModel([]);
    const svc = new BannerService(model, media, audit);

    const result = await svc.listActive(NOW);

    expect(result).toEqual([]);
  });

  it('queries only active banners and sorts by order', async () => {
    const { model, find, query } = makeModel([]);
    const svc = new BannerService(model, media, audit);

    await svc.listActive(NOW);

    expect(find).toHaveBeenCalledWith({ isActive: true });
    expect(query.sort).toHaveBeenCalledWith({ order: 1, createdAt: 1 });
  });

  it('drops banners whose live window excludes now, keeps the live ones', async () => {
    const live = banner({ title: 'live', order: 1, liveFrom: past(60), liveUntil: future(60) });
    const notYet = banner({ title: 'future', order: 2, liveFrom: future(10) });
    const expired = banner({ title: 'past', order: 3, liveUntil: past(10) });
    // NOTE: model only returns isActive:true docs, so inactive never reaches here.
    const { model } = makeModel([live, notYet, expired]);
    const svc = new BannerService(model, media, audit);

    const result = await svc.listActive(NOW);

    // Public payload has no `title`; `alt` falls back to title when blank.
    expect(result.map((b) => b.alt)).toEqual(['live']);
  });

  it('maps to the public shape with signed imageUrl, alt falling back to title', async () => {
    const doc = banner({
      _id: new Types.ObjectId(),
      imageUrl: 'r2-private://banners/x.jpg',
      linkUrl: 'https://z.example.com',
      title: 'Sale',
      alt: '',
      order: 5,
    });
    const signed = new Map([['r2-private://banners/x.jpg', 'https://signed.example.com/x?sig=1']]);
    const localMedia = { signMany: vi.fn().mockResolvedValue(signed), resolve } as never;
    const { model } = makeModel([doc]);
    const svc = new BannerService(model, localMedia, audit);

    const [b] = await svc.listActive(NOW);

    expect(b).toEqual({
      id: doc._id.toString(),
      imageUrl: 'https://signed.example.com/x?sig=1',
      linkUrl: 'https://z.example.com',
      alt: 'Sale', // falls back to title when alt is blank
      order: 5,
    });
  });
});
