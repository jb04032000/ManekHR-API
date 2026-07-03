/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema imports (Listing, and Subscription/Plan via
// ConnectAllowanceService) do not trip vitest's reflect-metadata pipeline.
// Models + injected services are supplied as plain positional mocks.
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
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ListingService } from '../listing.service';
import { AppModule } from '../../../../../common/enums/modules.enum';

// --- Mock helpers ------------------------------------------------------------

/** Minimal mongoose-document stand-in with a save spy. */
function makeDoc<T extends Record<string, unknown>>(fields: T) {
  return { ...fields, save: vi.fn().mockResolvedValue(undefined) };
}

/** A chainable query stand-in: supports .sort()/.select()/.limit()/.lean().exec() in any order. */
function queryChain(result: any) {
  const obj: any = {
    sort: vi.fn(() => obj),
    select: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    lean: vi.fn(() => obj),
    exec: vi.fn(() => Promise.resolve(result)),
  };
  return obj;
}

function makeModel() {
  return {
    countDocuments: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findById: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  };
}

const OWNER = new Types.ObjectId().toHexString();
const OTHER = new Types.ObjectId().toHexString();

function build() {
  const model = makeModel();
  const inquiryModel = makeModel();
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
  const audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const eventEmitter = { emit: vi.fn() };
  const posthog = { capture: vi.fn() };
  const defaultStorefrontId = new Types.ObjectId();
  const storefronts = {
    getMine: vi.fn().mockResolvedValue({ _id: defaultStorefrontId }),
    getOrCreateDefaultStorefront: vi.fn().mockResolvedValue({ _id: defaultStorefrontId }),
    findPublicIdsByCompanyPage: vi.fn().mockResolvedValue([]),
  };
  // Category + tags resolve through TagService (open-tag path: lowercase +
  // hyphenate the raw term). recordUsage is a fire-and-forget spy.
  const tagService = {
    normalizeHashtags: vi
      .fn()
      .mockImplementation((raw: string[]) =>
        Promise.resolve(raw.map((r) => r.toLowerCase().trim().replace(/\s+/g, '-'))),
      ),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  };
  // Stub media-ownership guard (trailing @Optional ctor arg): the real guard is
  // verified in the uploads module; here we only need it to no-op.
  const media = {
    assertOwnedMedia: vi.fn(() => Promise.resolve()),
    assertOwnedSingle: vi.fn(() => Promise.resolve()),
    // Server-derived video duration (the source of truth for a stored clip).
    // Defaults to null (no probe on file); per-test mocks override it.
    getServerVideoDurationByUrl: vi.fn(() => Promise.resolve(null as number | null)),
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
  return {
    service,
    model,
    inquiryModel,
    allowances,
    storefronts,
    defaultStorefrontId,
    audit,
    eventEmitter,
    posthog,
    tagService,
    media,
  };
}

const validInput = {
  title: 'Cotton weaving job work',
  description: 'Power-loom weaving, 60x60 count',
  category: 'weaving' as const,
  priceType: 'range' as const,
  priceMin: 12,
  priceMax: 18,
  unit: 'per-meter' as const,
  moq: 500,
  leadTimeDays: 7,
  location: { district: 'Surat', city: 'Surat', state: 'Gujarat' },
  images: ['https://cdn/x.jpg'],
};

describe('ListingService.create()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gates on assertCanCreateListing with the owner active-listing count BEFORE persisting', async () => {
    const f = build();
    f.model.countDocuments.mockResolvedValue(4);
    f.model.create.mockResolvedValue(makeDoc({ _id: new Types.ObjectId() }));

    await f.service.create(OWNER, validInput);

    expect(f.allowances.assertCanCreateListing).toHaveBeenCalledWith(OWNER, 4);
    // The count query is scoped to the owner's slot-occupying statuses.
    const countArg = f.model.countDocuments.mock.calls[0][0];
    expect(String(countArg.ownerUserId)).toBe(OWNER);
    expect(countArg.status.$in).toContain('active');
  });

  it('does NOT persist and rethrows when the cap is reached', async () => {
    const f = build();
    f.model.countDocuments.mockResolvedValue(25);
    // Canonical 403 shape thrown by ConnectAllowanceService when the cap is hit:
    // { code: 'CONNECT_LIMIT_REACHED', kind, limit, used } (see
    // connect-allowance.service.ts). This fixture matches the live exception.
    f.allowances.assertCanCreateListing.mockRejectedValue(
      new ForbiddenException({
        code: 'CONNECT_LIMIT_REACHED',
        kind: 'listing',
        limit: 25,
        used: 25,
      }),
    );

    await expect(f.service.create(OWNER, validInput)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.model.create).not.toHaveBeenCalled();
  });

  it('persists with the owner from the JWT and publishes live (active + approved) while moderation is off', async () => {
    const f = build();
    const created = makeDoc({ _id: new Types.ObjectId() });
    f.model.create.mockResolvedValue(created);

    const result = await f.service.create(OWNER, validInput);

    const payload = f.model.create.mock.calls[0][0];
    expect(String(payload.ownerUserId)).toBe(OWNER);
    expect(payload.title).toBe(validInput.title);
    expect(payload.category).toBe('weaving');
    expect(payload.status).toBe('active');
    expect(payload.moderationStatus).toBe('approved');
    expect(result).toBe(created);
  });

  it('persists courseDetails for a course listing (Institutes Phase 1)', async () => {
    const f = build();
    f.model.create.mockResolvedValue(makeDoc({ _id: new Types.ObjectId() }));
    const courseInput = {
      title: 'Computerised Embroidery (6 weeks)',
      category: 'course' as const,
      priceType: 'fixed' as const,
      priceMin: 8000,
      courseDetails: {
        durationLabel: '6 weeks',
        mode: 'offline' as const,
        feeType: 'fixed' as const,
        seats: 20,
        certificate: true,
        skillsTaught: ['digitising', 'multi-head'],
      },
    };
    await f.service.create(OWNER, courseInput);
    const payload = f.model.create.mock.calls[0][0];
    expect(payload.category).toBe('course');
    expect(payload.courseDetails).toEqual(courseInput.courseDetails);
  });

  it('nulls courseDetails for a non-course listing even if sent', async () => {
    const f = build();
    f.model.create.mockResolvedValue(makeDoc({ _id: new Types.ObjectId() }));
    await f.service.create(OWNER, {
      ...validInput,
      // A stray courseDetails on a non-course listing must not persist.
      courseDetails: { durationLabel: 'x', mode: 'online' as const, feeType: 'free' as const },
    } as never);
    const payload = f.model.create.mock.calls[0][0];
    expect(payload.courseDetails).toBeNull();
  });

  it('uses the owner default storefront when none is given and stamps storefrontId (W3)', async () => {
    const f = build();
    f.model.create.mockResolvedValue(makeDoc({ _id: new Types.ObjectId() }));

    await f.service.create(OWNER, validInput);

    expect(f.storefronts.getOrCreateDefaultStorefront).toHaveBeenCalledWith(OWNER);
    expect(f.storefronts.getMine).not.toHaveBeenCalled();
    const payload = f.model.create.mock.calls[0][0];
    expect(String(payload.storefrontId)).toBe(String(f.defaultStorefrontId));
  });

  it('uses the provided storefront, verified owned via getMine (W3)', async () => {
    const f = build();
    f.model.create.mockResolvedValue(makeDoc({ _id: new Types.ObjectId() }));

    await f.service.create(OWNER, { ...validInput, storefrontId: 'sf-chosen' });

    expect(f.storefronts.getMine).toHaveBeenCalledWith(OWNER, 'sf-chosen');
    expect(f.storefronts.getOrCreateDefaultStorefront).not.toHaveBeenCalled();
  });

  it('audits listing_created under AppModule.CONNECT and emits the PostHog event', async () => {
    const f = build();
    const id = new Types.ObjectId();
    f.model.create.mockResolvedValue(makeDoc({ _id: id }));

    await f.service.create(OWNER, validInput);

    expect(f.audit.logEvent).toHaveBeenCalledOnce();
    const call = f.audit.logEvent.mock.calls[0][0];
    expect(call.module).toBe(AppModule.CONNECT);
    expect(call.action).toBe('listing_created');
    expect(call.actorId).toBe(OWNER);
    expect(call.entityId).toBe(String(id));

    expect(f.posthog.capture).toHaveBeenCalledOnce();
    expect(f.posthog.capture.mock.calls[0][0].event).toBe('connect.listing_created');
    expect(f.posthog.capture.mock.calls[0][0].distinctId).toBe(OWNER);
  });

  it('persists an owned product video and stamps the SERVER-derived durationSec', async () => {
    const f = build();
    f.model.create.mockResolvedValue(makeDoc({ _id: new Types.ObjectId() }));
    // The owned upload record probed this clip at 45s (within the 60s cap).
    f.media.getServerVideoDurationByUrl.mockResolvedValue(45);

    await f.service.create(OWNER, {
      ...validInput,
      videos: [{ url: 'https://cdn/clip.mp4', posterUrl: 'https://cdn/poster.jpg' }],
    });

    // url + posterUrl both ownership-checked (flattened into one guard call).
    const ownArg = f.media.assertOwnedMedia.mock.calls.find((c: any[]) =>
      (c[0] as string[]).includes('https://cdn/clip.mp4'),
    );
    expect(ownArg?.[0]).toEqual(
      expect.arrayContaining(['https://cdn/clip.mp4', 'https://cdn/poster.jpg']),
    );
    const payload = f.model.create.mock.calls[0][0];
    expect(payload.videos).toEqual([
      { url: 'https://cdn/clip.mp4', posterUrl: 'https://cdn/poster.jpg', durationSec: 45 },
    ]);
  });

  it('rejects a video URL the caller does not own (media-ownership guard throws)', async () => {
    const f = build();
    f.media.assertOwnedMedia.mockRejectedValue(new BadRequestException('not yours'));

    await expect(
      f.service.create(OWNER, { ...validInput, videos: [{ url: 'https://cdn/foreign.mp4' }] }),
    ).rejects.toThrow();
    expect(f.model.create).not.toHaveBeenCalled();
  });

  it('leaves videos empty (unchanged behavior) when none are submitted', async () => {
    const f = build();
    f.model.create.mockResolvedValue(makeDoc({ _id: new Types.ObjectId() }));

    await f.service.create(OWNER, validInput);

    const payload = f.model.create.mock.calls[0][0];
    expect(payload.videos).toEqual([]);
    expect(f.media.getServerVideoDurationByUrl).not.toHaveBeenCalled();
  });
});

// ── CN-LIM-3: the create-cap check+insert is atomic under the per-owner mutex ──
//
// A real serializing fake of SingleFlightService.withLock (queues same-key
// callers, one-at-a-time) over an in-memory listing store proves the race is
// closed: two concurrent creates at limit-1 yield exactly ONE insert; the second
// caller re-counts INSIDE the lock, sees the incremented total, and is rejected.
describe('ListingService.create() — cap race (CN-LIM-3)', () => {
  /** withLock that genuinely serializes callers sharing a lockName (per-key queue). */
  function serializingLock() {
    const chains = new Map<string, Promise<unknown>>();
    return {
      calls: [] as string[],
      withLock<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
        this.calls.push(lockName);
        const prev = chains.get(lockName) ?? Promise.resolve();
        const run = prev.then(() => fn());
        // Keep the chain alive regardless of fn()'s success/failure so a rejected
        // create still releases the lock for the next queued caller.
        chains.set(
          lockName,
          run.then(
            () => undefined,
            () => undefined,
          ),
        );
        return run;
      },
    };
  }

  /** A listing service backed by a shared in-memory count, with a real serializing lock. */
  function buildWithLock(maxListings: number) {
    const store: Array<Record<string, unknown>> = [];
    const model = makeModel();
    // countDocuments reflects the live store size (per-owner scope is a given here).
    model.countDocuments = vi.fn(() => Promise.resolve(store.length));
    model.create = vi.fn((doc: Record<string, unknown>) => {
      const created = { _id: new Types.ObjectId(), ...doc };
      store.push(created);
      return Promise.resolve(created);
    });
    // Real cap assertion so the second caller is actually rejected at the limit.
    const allowances = {
      assertCanCreateListing: vi.fn((_uid: string, used: number) => {
        if (used >= maxListings) {
          return Promise.reject(
            new ForbiddenException({ code: 'CONNECT_LIMIT_REACHED', kind: 'listing' }),
          );
        }
        return Promise.resolve();
      }),
      getAllowances: vi.fn().mockResolvedValue({ maxListings }),
    };
    const audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const eventEmitter = { emit: vi.fn() };
    const posthog = { capture: vi.fn() };
    const sfId = new Types.ObjectId();
    const storefronts = {
      getMine: vi.fn().mockResolvedValue({ _id: sfId }),
      getOrCreateDefaultStorefront: vi.fn().mockResolvedValue({ _id: sfId }),
    };
    const tagService = {
      normalizeHashtags: vi.fn((raw: string[]) => Promise.resolve(raw.map((r) => r.toLowerCase()))),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    };
    const media = { assertOwnedMedia: vi.fn(() => Promise.resolve()) };
    const lock = serializingLock();
    const service = new ListingService(
      model as any,
      makeModel() as any,
      allowances as any,
      storefronts as any,
      audit as any,
      eventEmitter as any,
      posthog as any,
      tagService as any,
      undefined, // reviews
      undefined, // userModel
      media as any,
      undefined, // overLimit
      lock as any, // capLock (CN-LIM-3, LAST positional)
    );
    return { service, model, allowances, store, lock };
  }

  it('two concurrent creates at limit-1 → exactly one inserts, the other is rejected at the cap', async () => {
    const f = buildWithLock(1); // cap = 1; store starts empty (used 0 = at limit-1)

    const results = await Promise.allSettled([
      f.service.create(OWNER, validInput),
      f.service.create(OWNER, validInput),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // The cap held under concurrency: one create, one 403 — never both inserting.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ForbiddenException);
    expect(f.model.create).toHaveBeenCalledTimes(1);
    expect(f.store).toHaveLength(1); // landed at the cap, NOT cap+1
  });

  it('both creates take the SAME per-owner listing lock key (so they serialize)', async () => {
    const f = buildWithLock(5);
    await Promise.allSettled([
      f.service.create(OWNER, validInput),
      f.service.create(OWNER, validInput),
    ]);
    const expectedKey = `connect:cap:listing:${OWNER}`;
    expect(f.lock.calls).toEqual([expectedKey, expectedKey]);
  });
});

describe('ListingService.update()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NotFoundException when the listing is missing', async () => {
    const f = build();
    f.model.findById.mockResolvedValue(null);
    await expect(f.service.update('id', OWNER, { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the caller is not the owner', async () => {
    const f = build();
    f.model.findById.mockResolvedValue(makeDoc({ _id: 'id', ownerUserId: OTHER }));
    await expect(f.service.update('id', OWNER, { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('patches provided fields and saves', async () => {
    const f = build();
    const doc = makeDoc({
      _id: 'id',
      ownerUserId: OWNER,
      status: 'draft',
      moderationStatus: 'pending',
      title: 'old',
    });
    f.model.findById.mockResolvedValue(doc);

    await f.service.update('id', OWNER, { title: 'new title', priceMin: 99 });

    expect(doc.title).toBe('new title');
    expect((doc as any).priceMin).toBe(99);
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('keeps an approved listing live on edit (no re-moderation while moderation is off)', async () => {
    const f = build();
    const doc = makeDoc({
      _id: 'id',
      ownerUserId: OWNER,
      status: 'active',
      moderationStatus: 'approved',
      title: 'old',
    });
    f.model.findById.mockResolvedValue(doc);

    await f.service.update('id', OWNER, { title: 'edited' });

    expect(doc.moderationStatus).toBe('approved');
    expect(doc.status).toBe('active');
    expect(f.audit.logEvent.mock.calls[0][0].action).toBe('listing_updated');
  });

  it('keeps the existing video (grandfathered) while changing images on the same edit', async () => {
    const f = build();
    const existingVideo = { url: 'https://cdn/old.mp4', posterUrl: 'https://cdn/oldposter.jpg' };
    const doc = makeDoc({
      _id: 'id',
      ownerUserId: OWNER,
      status: 'active',
      moderationStatus: 'approved',
      images: ['https://cdn/old.jpg'],
      videos: [existingVideo],
    });
    f.model.findById.mockResolvedValue(doc);
    f.media.getServerVideoDurationByUrl.mockResolvedValue(30);

    await f.service.update('id', OWNER, {
      images: ['https://cdn/new.jpg'],
      videos: [existingVideo],
    });

    // Images guard grandfathers the listing's current images.
    const imgCall = f.media.assertOwnedMedia.mock.calls.find((c: any[]) =>
      (c[0] as string[]).includes('https://cdn/new.jpg'),
    );
    expect(imgCall?.[1]).toBe(OWNER);
    expect(imgCall?.[2]?.grandfatheredUrls).toEqual(['https://cdn/old.jpg']);
    // Video guard grandfathers the existing clip url + poster (no new ownership
    // record required to keep it), and the duration is re-stamped server-side.
    const vidCall = f.media.assertOwnedMedia.mock.calls.find((c: any[]) =>
      (c[0] as string[]).includes('https://cdn/old.mp4'),
    );
    expect(vidCall?.[2]?.grandfatheredUrls).toEqual(
      expect.arrayContaining(['https://cdn/old.mp4', 'https://cdn/oldposter.jpg']),
    );
    expect((doc as any).videos).toEqual([
      { url: 'https://cdn/old.mp4', posterUrl: 'https://cdn/oldposter.jpg', durationSec: 30 },
    ]);
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('leaves the existing video untouched when videos is omitted from the patch', async () => {
    const f = build();
    const doc = makeDoc({
      _id: 'id',
      ownerUserId: OWNER,
      status: 'active',
      moderationStatus: 'approved',
      videos: [{ url: 'https://cdn/keep.mp4', durationSec: 20 }],
    });
    f.model.findById.mockResolvedValue(doc);

    await f.service.update('id', OWNER, { title: 'just a title change' });

    expect((doc as any).videos).toEqual([{ url: 'https://cdn/keep.mp4', durationSec: 20 }]);
    expect(f.media.getServerVideoDurationByUrl).not.toHaveBeenCalled();
  });
});

describe('ListingService.publish()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets status active when moderation is approved', async () => {
    const f = build();
    const doc = makeDoc({
      _id: 'id',
      ownerUserId: OWNER,
      status: 'paused',
      moderationStatus: 'approved',
    });
    f.model.findById.mockResolvedValue(doc);

    await f.service.publish('id', OWNER);

    expect(doc.status).toBe('active');
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('publishes live (active) while moderation is off, even when not yet approved', async () => {
    const f = build();
    const doc = makeDoc({
      _id: 'id',
      ownerUserId: OWNER,
      status: 'draft',
      moderationStatus: 'pending',
    });
    f.model.findById.mockResolvedValue(doc);

    await f.service.publish('id', OWNER);

    expect(doc.status).toBe('active');
  });
});

describe('ListingService.pause()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pauses an active listing and audits', async () => {
    const f = build();
    const doc = makeDoc({
      _id: 'id',
      ownerUserId: OWNER,
      status: 'active',
      moderationStatus: 'approved',
    });
    f.model.findById.mockResolvedValue(doc);

    await f.service.pause('id', OWNER);

    expect(doc.status).toBe('paused');
    expect(doc.save).toHaveBeenCalledOnce();
    expect(f.audit.logEvent.mock.calls[0][0].action).toBe('listing_paused');
  });

  it('is a no-op (no save, no audit) when the listing is not active', async () => {
    const f = build();
    const doc = makeDoc({
      _id: 'id',
      ownerUserId: OWNER,
      status: 'draft',
      moderationStatus: 'pending',
    });
    f.model.findById.mockResolvedValue(doc);

    await f.service.pause('id', OWNER);

    expect(doc.save).not.toHaveBeenCalled();
    expect(f.audit.logEvent).not.toHaveBeenCalled();
  });
});

describe('ListingService.remove()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes the owner listing and audits listing_deleted', async () => {
    const f = build();
    const oid = new Types.ObjectId();
    f.model.findById.mockResolvedValue(makeDoc({ _id: oid, ownerUserId: OWNER }));

    await f.service.remove(oid.toHexString(), OWNER);

    expect(f.model.deleteOne).toHaveBeenCalledOnce();
    expect(f.audit.logEvent.mock.calls[0][0].action).toBe('listing_deleted');
  });

  it('throws NotFoundException (and does not delete) for a non-owner', async () => {
    const f = build();
    f.model.findById.mockResolvedValue(makeDoc({ _id: 'id', ownerUserId: OTHER }));

    await expect(f.service.remove('id', OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.model.deleteOne).not.toHaveBeenCalled();
  });
});

describe('ListingService.listMine()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries by ownerUserId and returns the lean result', async () => {
    const f = build();
    const rows = [{ _id: '1' }, { _id: '2' }];
    f.model.find.mockReturnValue(queryChain(rows));

    const result = await f.service.listMine(OWNER);

    const findArg = f.model.find.mock.calls[0][0];
    expect(String(findArg.ownerUserId)).toBe(OWNER);
    expect(findArg.storefrontId).toBeUndefined(); // flat: no storefront scope
    expect(result).toEqual(rows);
  });

  it('scopes to a storefront when a valid storefrontId is given', async () => {
    const f = build();
    f.model.find.mockReturnValue(queryChain([]));
    const STORE = '60b0000000000000000000d1';

    await f.service.listMine(OWNER, STORE);

    const findArg = f.model.find.mock.calls[0][0];
    expect(String(findArg.ownerUserId)).toBe(OWNER);
    expect(String(findArg.storefrontId)).toBe(STORE);
  });
});

describe('ListingService.getPublic()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an active + approved listing, stamped not-verified for a free seller', async () => {
    const f = build();
    const row = { _id: 'id', ownerUserId: OWNER, status: 'active', moderationStatus: 'approved' };
    f.model.findOne.mockReturnValue(queryChain(row));

    const result = await f.service.getPublic('id');

    const arg = f.model.findOne.mock.calls[0][0];
    expect(arg.status).toBe('active');
    expect(arg.moderationStatus).toBe('approved');
    // getPublic also joins the owning shop's breadcrumb; null here (no storefrontId).
    // Demo Content scope: getPublic coerces the denormalized isDemo to a hard
    // boolean (false here — the row has no demo owner) so the web Sample badge
    // never sees undefined.
    expect(result).toEqual({ ...row, verified: false, storefront: null, isDemo: false });
  });

  it('stamps the seller verified flag from their allowances (M2.3)', async () => {
    const f = build();
    const row = { _id: 'id', ownerUserId: OWNER, status: 'active', moderationStatus: 'approved' };
    f.model.findOne.mockReturnValue(queryChain(row));
    f.allowances.getAllowances.mockResolvedValue({
      maxListings: -1,
      leadsPerMonth: -1,
      includedBoostCredits: 10,
      verifiedBadge: true,
      searchPriority: 5,
    });

    const result = await f.service.getPublic('id');

    expect(result.verified).toBe(true);
    expect(f.allowances.getAllowances).toHaveBeenCalledWith(OWNER);
  });

  it('throws NotFoundException when no active + approved listing matches', async () => {
    const f = build();
    f.model.findOne.mockReturnValue(queryChain(null));

    await expect(f.service.getPublic('id')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ListingService.listPublicByStorefront() (W3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns active+approved listings mapped to refs, verified stamped once', async () => {
    const f = build();
    const row = {
      _id: 'l1',
      ownerUserId: OWNER,
      title: 'Zari thread',
      description: '',
      category: 'raw-material',
      priceType: 'negotiable',
      location: { district: 'Surat' },
      images: ['https://cdn/a.jpg'],
      createdAt: '2026-01-01',
    };
    f.model.find.mockReturnValue(queryChain([row]));
    f.allowances.getAllowances.mockResolvedValue({ verifiedBadge: true } as any);

    const SF = new Types.ObjectId().toHexString();
    const result = await f.service.listPublicByStorefront(SF);

    const findArg = f.model.find.mock.calls[0][0];
    expect(String(findArg.storefrontId)).toBe(SF);
    expect(findArg.status).toBe('active');
    expect(findArg.moderationStatus).toBe('approved');
    expect(f.allowances.getAllowances).toHaveBeenCalledWith(OWNER);
    expect(result).toHaveLength(1);
    expect(result[0].listingId).toBe('l1');
    expect(result[0].verified).toBe(true);
    expect(result[0].coverImage).toBe('https://cdn/a.jpg');
  });

  it('returns [] when the storefront has no public listings (no allowance lookup)', async () => {
    const f = build();
    f.model.find.mockReturnValue(queryChain([]));
    const result = await f.service.listPublicByStorefront(new Types.ObjectId().toHexString());
    expect(result).toEqual([]);
    expect(f.allowances.getAllowances).not.toHaveBeenCalled();
  });
});

describe('ListingService.listPublicByCompanyPage()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries listings across the page-linked storefront ids and maps to refs', async () => {
    const f = build();
    const sfA = new Types.ObjectId();
    const sfB = new Types.ObjectId();
    f.storefronts.findPublicIdsByCompanyPage.mockResolvedValue([sfA, sfB]);
    const row = {
      _id: 'l1',
      ownerUserId: OWNER,
      title: 'Gold zari border',
      description: '',
      category: 'embroidery-zari',
      priceType: 'fixed',
      location: { district: 'Surat' },
      images: ['https://cdn/a.jpg'],
      createdAt: '2026-01-01',
    };
    f.model.find.mockReturnValue(queryChain([row]));
    f.allowances.getAllowances.mockResolvedValue({ verifiedBadge: true } as any);

    const PAGE = new Types.ObjectId().toHexString();
    const result = await f.service.listPublicByCompanyPage(PAGE);

    expect(f.storefronts.findPublicIdsByCompanyPage).toHaveBeenCalledWith(PAGE);
    const findArg = f.model.find.mock.calls[0][0];
    expect(findArg.storefrontId.$in).toEqual([sfA, sfB]);
    expect(findArg.status).toBe('active');
    expect(findArg.moderationStatus).toBe('approved');
    expect(result).toHaveLength(1);
    expect(result[0].listingId).toBe('l1');
    expect(result[0].verified).toBe(true);
  });

  it('short-circuits to [] when the page has no linked public storefronts', async () => {
    const f = build();
    f.storefronts.findPublicIdsByCompanyPage.mockResolvedValue([]);
    const result = await f.service.listPublicByCompanyPage(new Types.ObjectId().toHexString());
    expect(result).toEqual([]);
    expect(f.model.find).not.toHaveBeenCalled();
    expect(f.allowances.getAllowances).not.toHaveBeenCalled();
  });
});

describe('ListingService.storefrontStats()', () => {
  beforeEach(() => vi.clearAllMocks());

  const SF1 = new Types.ObjectId();
  const SF2 = new Types.ObjectId();
  const L1 = new Types.ObjectId(); // SF1, active+approved (live)
  const L2 = new Types.ObjectId(); // SF1, draft (not live)
  const L3 = new Types.ObjectId(); // SF2, active+approved (live)

  it('tallies products + live per storefront and attributes inquiries to the right shop', async () => {
    const f = build();
    f.model.find.mockReturnValue(
      queryChain([
        // Live == active + approved + a cover photo (the public grid's gate).
        {
          _id: L1,
          storefrontId: SF1,
          status: 'active',
          moderationStatus: 'approved',
          images: ['a.jpg'],
        },
        { _id: L2, storefrontId: SF1, status: 'draft', moderationStatus: 'pending', images: [] },
        {
          _id: L3,
          storefrontId: SF2,
          status: 'active',
          moderationStatus: 'approved',
          images: ['b.jpg'],
        },
      ]),
    );
    // Two inquiries on L1 (SF1), one on L3 (SF2).
    f.inquiryModel.find.mockReturnValue(
      queryChain([{ listingId: L1 }, { listingId: L1 }, { listingId: L3 }]),
    );

    const result = await f.service.storefrontStats(OWNER);

    // Scoped strictly to the owner's listings.
    const listingFindArg = f.model.find.mock.calls[0][0];
    expect(String(listingFindArg.ownerUserId)).toBe(OWNER);
    // Inquiries fetched only for the owner's listing ids ($in).
    const inquiryFindArg = f.inquiryModel.find.mock.calls[0][0];
    expect(inquiryFindArg.listingId.$in.map(String).sort()).toEqual(
      [String(L1), String(L2), String(L3)].sort(),
    );

    const byId = new Map(result.map((r) => [r.storefrontId, r]));
    expect(byId.get(String(SF1))).toEqual({
      storefrontId: String(SF1),
      products: 2,
      live: 1,
      inquiries: 2,
    });
    expect(byId.get(String(SF2))).toEqual({
      storefrontId: String(SF2),
      products: 1,
      live: 1,
      inquiries: 1,
    });
    expect(result).toHaveLength(2);
  });

  it('does NOT count an active+approved listing with no photo as live', async () => {
    // A photoless listing is hidden from the public store grid, so it is a
    // product but not "live" - the gate must require a cover photo.
    const f = build();
    f.model.find.mockReturnValue(
      queryChain([
        { _id: L1, storefrontId: SF1, status: 'active', moderationStatus: 'approved', images: [] },
      ]),
    );
    f.inquiryModel.find.mockReturnValue(queryChain([]));

    const result = await f.service.storefrontStats(OWNER);

    expect(result).toEqual([{ storefrontId: String(SF1), products: 1, live: 0, inquiries: 0 }]);
  });

  it('skips listings with a null storefrontId (legacy un-shopped rows)', async () => {
    const f = build();
    f.model.find.mockReturnValue(
      queryChain([
        {
          _id: L1,
          storefrontId: SF1,
          status: 'active',
          moderationStatus: 'approved',
          images: ['a.jpg'],
        },
        {
          _id: L2,
          storefrontId: null,
          status: 'active',
          moderationStatus: 'approved',
          images: ['b.jpg'],
        },
      ]),
    );
    f.inquiryModel.find.mockReturnValue(queryChain([]));

    const result = await f.service.storefrontStats(OWNER);

    // Only SF1 appears; the null-storefront listing id is NOT in the inquiry $in.
    expect(result).toEqual([{ storefrontId: String(SF1), products: 1, live: 1, inquiries: 0 }]);
    const inquiryFindArg = f.inquiryModel.find.mock.calls[0][0];
    expect(inquiryFindArg.listingId.$in.map(String)).toEqual([String(L1)]);
  });

  it('returns [] and skips the inquiry query when the owner has no shopped listings', async () => {
    const f = build();
    f.model.find.mockReturnValue(queryChain([]));

    const result = await f.service.storefrontStats(OWNER);

    expect(result).toEqual([]);
    expect(f.inquiryModel.find).not.toHaveBeenCalled();
  });
});

describe('ListingService.publish() reactivation cap gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-checks the cap when reactivating a non-slot (expired) listing into a slot', async () => {
    const f = build();
    // Listing currently expired (occupies no slot) -> publishing it back to active
    // is creation-equivalent and must re-check the cap against OTHER slot listings.
    f.model.findById.mockResolvedValue(
      makeDoc({ _id: new Types.ObjectId(), ownerUserId: OWNER, status: 'expired' }),
    );
    f.model.countDocuments.mockResolvedValue(7);

    await f.service.publish('listing-id', OWNER);

    expect(f.allowances.assertCanCreateListing).toHaveBeenCalledWith(OWNER, 7);
    // Count excludes the listing being republished so it never blocks itself.
    const countArg = f.model.countDocuments.mock.calls[0][0];
    expect(countArg._id).toEqual({ $ne: expect.anything() });
    expect(countArg.status.$in).toContain('active');
  });

  it('does NOT re-check the cap when publishing a listing already in a slot (paused)', async () => {
    const f = build();
    f.model.findById.mockResolvedValue(
      makeDoc({ _id: new Types.ObjectId(), ownerUserId: OWNER, status: 'paused' }),
    );

    await f.service.publish('listing-id', OWNER);

    expect(f.allowances.assertCanCreateListing).not.toHaveBeenCalled();
  });

  it('does NOT save when the reactivation cap is reached', async () => {
    const f = build();
    const doc = makeDoc({ _id: new Types.ObjectId(), ownerUserId: OWNER, status: 'expired' });
    f.model.findById.mockResolvedValue(doc);
    f.model.countDocuments.mockResolvedValue(25);
    f.allowances.assertCanCreateListing.mockRejectedValue(
      new ForbiddenException({ code: 'CONNECT_LIMIT_REACHED', kind: 'listing' }),
    );

    await expect(f.service.publish('listing-id', OWNER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(doc.save).not.toHaveBeenCalled();
  });
});
