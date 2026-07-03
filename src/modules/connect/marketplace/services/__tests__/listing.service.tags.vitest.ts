/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema imports don't trip vitest's reflect-metadata
// pipeline. Models + injected services are supplied as plain positional mocks.
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
import { ListingService } from '../listing.service';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal mongoose-document stand-in with a save spy. */
function makeDoc<T extends Record<string, unknown>>(fields: T) {
  return { ...fields, save: vi.fn().mockResolvedValue(undefined) };
}

function makeListingModel(capturedPayload: { value?: unknown }) {
  return {
    countDocuments: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation((payload: unknown) => {
      capturedPayload.value = payload;
      return Promise.resolve(makeDoc({ _id: new Types.ObjectId(), ...(payload as object) }));
    }),
    findById: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  };
}

/**
 * Build a `ListingService` with a real-ish `tagService` mock:
 * - `normalizeHashtags` lowercases and hyphenates (mirrors open-tag path for
 *   terms not in the DB).
 * - `recordUsage` is a spy so we can assert it was called.
 */
function build(capturedPayload: { value?: unknown }) {
  const tagService = {
    normalizeHashtags: vi
      .fn()
      .mockImplementation((raw: string[]) =>
        Promise.resolve(raw.map((r) => r.toLowerCase().replace(/\s+/g, '-'))),
      ),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  };

  const model = makeListingModel(capturedPayload);
  const inquiryModel = {
    countDocuments: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findById: vi.fn(),
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    findOne: vi.fn(),
    deleteOne: vi.fn(),
  };
  const allowances = {
    assertCanCreateListing: vi.fn().mockResolvedValue(undefined),
    getAllowances: vi.fn().mockResolvedValue({
      maxListings: 25,
      leadsPerMonth: -1,
      includedBoostCredits: 0,
      verifiedBadge: false,
      searchPriority: 0,
    }),
  };
  const storefronts = {
    getMine: vi.fn().mockResolvedValue({ _id: 'sf1' }),
    getOrCreateDefaultStorefront: vi.fn().mockResolvedValue({ _id: 'sf1' }),
  };
  const audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const eventEmitter = { emit: vi.fn() };
  const posthog = { capture: vi.fn() };

  // Stub media-ownership guard (trailing @Optional ctor arg): no-op here; the
  // real guard is covered by the uploads module's own tests.
  const media = {
    assertOwnedMedia: () => Promise.resolve(),
    assertOwnedSingle: () => Promise.resolve(),
  };

  const service = new ListingService(
    model as any,
    inquiryModel as any,
    allowances as any,
    storefronts as any,
    audit as any,
    eventEmitter as any,
    posthog as any,
    tagService as any,
    undefined, // reviews (@Optional)
    undefined, // userModel (@Optional)
    media as any,
  );

  return { service, model, tagService, storefronts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const OWNER = new Types.ObjectId().toHexString();

describe('ListingService — tag resolution on create()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls normalizeHashtags with raw tags and passes resolved slugs to create', async () => {
    const captured: { value?: unknown } = {};
    const { service, tagService } = build(captured);

    await service.create(OWNER, {
      title: 't',
      category: 'weaving',
      tags: ['Kanjivaram', '3 ply zari'],
    });

    expect(tagService.normalizeHashtags).toHaveBeenCalledWith(['Kanjivaram', '3 ply zari']);
    const payload = captured.value as Record<string, unknown>;
    expect(payload.tags).toEqual(['kanjivaram', '3-ply-zari']);
  });

  it('calls recordUsage with resolved slugs and ownerUserId', async () => {
    const captured: { value?: unknown } = {};
    const { service, tagService } = build(captured);

    await service.create(OWNER, {
      title: 't',
      category: 'weaving',
      tags: ['Kanjivaram', '3 ply zari'],
    });

    // recordUsage is fire-and-forget (void), settle microtasks
    await new Promise((r) => setImmediate(r));
    expect(tagService.recordUsage).toHaveBeenCalledWith(['kanjivaram', '3-ply-zari'], OWNER);
  });

  it('stores empty tags array when no tags provided (category still resolves)', async () => {
    const captured: { value?: unknown } = {};
    const { service, tagService } = build(captured);

    await service.create(OWNER, { title: 't', category: 'weaving' });

    await new Promise((r) => setImmediate(r));
    const payload = captured.value as Record<string, unknown>;
    expect(payload.tags).toEqual([]);
    // The category still goes through the tag engine (it is a dynamic value),
    // but no tag slugs are recorded beyond it.
    expect(tagService.normalizeHashtags).toHaveBeenCalledTimes(1);
    expect(tagService.normalizeHashtags).toHaveBeenCalledWith(['weaving']);
    expect(tagService.recordUsage).toHaveBeenCalledTimes(1);
    expect(tagService.recordUsage).toHaveBeenCalledWith(['weaving'], OWNER);
  });

  it('saves as draft (status draft) when asDraft is set, else active', async () => {
    const draftCap: { value?: unknown } = {};
    const draftSvc = build(draftCap);
    await draftSvc.service.create(OWNER, { title: 't', category: 'weaving', asDraft: true });
    expect((draftCap.value as Record<string, unknown>).status).toBe('draft');

    const liveCap: { value?: unknown } = {};
    const liveSvc = build(liveCap);
    await liveSvc.service.create(OWNER, { title: 't', category: 'weaving' });
    expect((liveCap.value as Record<string, unknown>).status).toBe('active');
  });
});

describe('ListingService — tag resolution on update()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves tags via normalizeHashtags and sets them on the document', async () => {
    const captured: { value?: unknown } = {};
    const { service, model, tagService } = build(captured);

    const docId = new Types.ObjectId();
    const doc = makeDoc({
      _id: docId,
      ownerUserId: OWNER,
      tags: ['old-tag'],
      title: 'original',
    });
    model.findById.mockResolvedValue(doc);

    await service.update(docId.toHexString(), OWNER, {
      tags: ['Bandhani', 'Silk blend'],
    });

    expect(tagService.normalizeHashtags).toHaveBeenCalledWith(['Bandhani', 'Silk blend']);
    expect((doc as any).tags).toEqual(['bandhani', 'silk-blend']);
  });

  it('calls recordUsage after update with resolved slugs', async () => {
    const captured: { value?: unknown } = {};
    const { service, model, tagService } = build(captured);

    const docId = new Types.ObjectId();
    const doc = makeDoc({ _id: docId, ownerUserId: OWNER, tags: [], title: 'original' });
    model.findById.mockResolvedValue(doc);

    await service.update(docId.toHexString(), OWNER, {
      tags: ['Bandhani'],
    });

    await new Promise((r) => setImmediate(r));
    expect(tagService.recordUsage).toHaveBeenCalledWith(['bandhani'], OWNER);
  });

  it('clears tags to empty array when update passes empty tags', async () => {
    const captured: { value?: unknown } = {};
    const { service, model, tagService } = build(captured);

    const docId = new Types.ObjectId();
    const doc = makeDoc({ _id: docId, ownerUserId: OWNER, tags: ['old-tag'], title: 'original' });
    model.findById.mockResolvedValue(doc);

    await service.update(docId.toHexString(), OWNER, { tags: [] });

    await new Promise((r) => setImmediate(r));
    expect((doc as any).tags).toEqual([]);
    expect(tagService.recordUsage).not.toHaveBeenCalled();
  });

  it('does not touch tags when patch omits tags field', async () => {
    const captured: { value?: unknown } = {};
    const { service, model, tagService } = build(captured);

    const docId = new Types.ObjectId();
    const doc = makeDoc({
      _id: docId,
      ownerUserId: OWNER,
      tags: ['existing-tag'],
      title: 'original',
    });
    model.findById.mockResolvedValue(doc);

    await service.update(docId.toHexString(), OWNER, { title: 'updated title' });

    await new Promise((r) => setImmediate(r));
    expect(tagService.normalizeHashtags).not.toHaveBeenCalled();
    expect((doc as any).tags).toEqual(['existing-tag']);
  });
});
