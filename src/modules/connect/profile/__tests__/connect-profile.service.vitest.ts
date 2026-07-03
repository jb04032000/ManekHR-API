import { describe, it, expect, vi } from 'vitest';
import type { Model } from 'mongoose';

// Stub @nestjs/mongoose BEFORE importing the service — it transitively imports
// the `User` schema, whose `@Prop()` decorators (no explicit `type`) trip
// vitest's SWC transform reflect-metadata pipeline. The service is unit-tested
// with plain mock models, so no real schema is needed. Mirrors the worked
// example in `erp-link.service.vitest.ts`.
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

import { ConnectProfileService, deriveOpenStatus } from '../connect-profile.service';
import type { ConnectProfile } from '../schemas/connect-profile.schema';

type UserModelArg = ConstructorParameters<typeof ConnectProfileService>[1];
type EmitterArg = ConstructorParameters<typeof ConnectProfileService>[2];

/**
 * Minimal `EventEmitter2` mock — `ConnectProfileService` only ever calls
 * `emit()` on it (fire-and-forget `connect.profile.changed` for the search
 * indexer). A fresh `vi.fn()`-backed stub per service so a test can assert the
 * emission if it wants; the strength / read-path tests simply ignore it.
 */
function mockEmitter(): EmitterArg {
  return { emit: vi.fn(() => true) } as unknown as EmitterArg;
}

/**
 * Minimal `ConnectAllowanceService` mock (M2.3). Only `getAllowances` is used
 * (by the public-profile verified marker); defaults to a free, not-verified
 * seller. Pass an override to simulate a verified seller.
 */
function mockAllowances(verifiedBadge = false): {
  getAllowances: ReturnType<typeof vi.fn>;
} {
  return {
    getAllowances: vi.fn().mockResolvedValue({
      maxListings: 25,
      leadsPerMonth: -1,
      includedBoostCredits: 0,
      verifiedBadge,
      searchPriority: 0,
    }),
  };
}

/**
 * Minimal mock `Model<ConnectProfile>`. `findOne()` / `find()` return one
 * chainable that resolves `result` on `.exec()` — supporting every builder
 * call the service makes (`populate` / `select` / `lean` / `sort` / `limit`).
 */
function mockModel(result: unknown) {
  const create = vi.fn((doc: unknown) => Promise.resolve(doc));
  const chain = {
    populate: vi.fn(() => chain),
    select: vi.fn(() => chain),
    lean: vi.fn(() => chain),
    sort: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    exec: () => Promise.resolve(result),
  };
  const model = {
    findOne: vi.fn(() => chain),
    find: vi.fn(() => chain),
    create,
  };
  return { model: model as unknown as Model<ConnectProfile>, create };
}

/** Minimal `Model<User>` mock — `findById(...).select(...).lean().exec()` + `updateOne(...).exec()`. */
function mockUserModel(
  user: { connectEnabled?: boolean; connectPolicyAcceptedAt?: Date | null } | null,
): UserModelArg {
  const chain = {
    select: vi.fn(() => chain),
    lean: vi.fn(() => chain),
    exec: () => Promise.resolve(user),
  };
  const updateChain = { exec: vi.fn(() => Promise.resolve({ modifiedCount: 1 })) };
  return {
    findById: vi.fn(() => chain),
    updateOne: vi.fn(() => updateChain),
  } as unknown as UserModelArg;
}

/** Build a profile-shaped object for `computeStrength`. */
function profile(
  over: Partial<Parameters<ConnectProfileService['computeStrength']>[0]> = {},
): Parameters<ConnectProfileService['computeStrength']>[0] {
  return {
    headline: '',
    bio: '',
    banner: '',
    skills: [],
    portfolio: [],
    experience: [],
    rateCard: undefined,
    ...over,
  };
}

describe('ConnectProfileService.computeStrength', () => {
  it('is 0 for an empty profile', () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    expect(svc.computeStrength(profile())).toBe(0);
  });

  it('is 100 for a fully-completed profile', () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const full = profile({
      headline: 'Master zari karigar',
      bio: '12 years on multi-head machines.',
      banner: 'https://cdn/banner.jpg',
      skills: ['zari', 'sequins', 'aari'],
      portfolio: [{ image: 'a.jpg' }] as never,
      experience: [{ workshop: 'Anat Textiles' }] as never,
      rateCard: { dailyWage: 90000 },
    });
    expect(svc.computeStrength(full)).toBe(100);
  });

  it('needs ≥ 3 skills to score the skills weight', () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    expect(svc.computeStrength(profile({ skills: ['zari', 'aari'] }))).toBe(0);
    expect(svc.computeStrength(profile({ skills: ['zari', 'aari', 'sequins'] }))).toBe(20);
  });

  it('blank-string fields do not count', () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    expect(svc.computeStrength(profile({ headline: '   ' }))).toBe(0);
  });
});

describe('ConnectProfileService.getOrCreateForUser', () => {
  const userId = '6a0a8f515ea9af111dd403bd';

  it('returns the existing profile when one exists', async () => {
    const existing = { userId, headline: 'hi' };
    const { model, create } = mockModel(existing);
    const result = await new ConnectProfileService(
      model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    ).getOrCreateForUser(userId);
    expect(result).toBe(existing);
    expect(create).not.toHaveBeenCalled();
  });

  it('lazily creates a profile when none exists', async () => {
    const { model, create } = mockModel(null);
    await new ConnectProfileService(
      model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    ).getOrCreateForUser(userId);
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('ConnectProfileService.getPublicByUserId', () => {
  it('returns a public profile, stamped not-verified for a free seller', async () => {
    const pub = { userId: '6a0a8f515ea9af111dd403bd', visibility: 'public' };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getPublicByUserId('6a0a8f515ea9af111dd403bd')).resolves.toEqual({
      ...pub,
      verified: false,
      // No company source injected -> empty experience / training company maps.
      experienceCompanies: {},
      trainingCompanies: {},
      // A legacy doc lacking these additive array fields is normalized to `[]` on
      // read (each is a required array in the read contract; see the regression
      // tests below). The `.lean()` read does not apply the schema `default: []`.
      training: [],
      skills: [],
      portfolio: [],
      experience: [],
      services: [],
      recommendations: [],
      videos: [],
    });
  });

  it('normalizes a legacy doc with NO training field to training: [] (read contract)', async () => {
    // Repro of the live "Connect could not load" crash: an older public profile
    // created before the Institutes `training` field existed. The `.lean()` read
    // does not apply the schema default, so the stored doc has no `training` key.
    // The read MUST still return `training: []` so the web ProfileView's
    // `profile.training.length` does not throw and blank the whole route.
    const legacy = {
      userId: '6a0a8f515ea9af111dd403bd',
      visibility: 'public',
      skills: ['stitching'],
      // note: no `training` key at all
    };
    const svc = new ConnectProfileService(
      mockModel(legacy).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.getPublicByUserId('6a0a8f515ea9af111dd403bd');
    expect(result.training).toEqual([]);
  });

  it('normalizes a legacy doc missing the `services` field to services: [] (read contract)', async () => {
    // Exact repro of the live crash at /connect/u/<id>: a public profile saved
    // BEFORE the `services` field existed has `skills` persisted but no `services`
    // key. The `.lean()` read skips the schema default, so the web ProfileView's
    // `profile.services.length` threw "Cannot read properties of undefined". Every
    // additive array the web reads unguarded must come back as [].
    const legacy = {
      userId: '6a0a8f515ea9af111dd403bd',
      visibility: 'public',
      skills: ['zari'],
      // note: no `services`, `portfolio`, `experience`, `recommendations`, `videos` keys
    };
    const svc = new ConnectProfileService(
      mockModel(legacy).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.getPublicByUserId('6a0a8f515ea9af111dd403bd');
    expect(result.services).toEqual([]);
    expect(result.portfolio).toEqual([]);
    expect(result.experience).toEqual([]);
    expect(result.recommendations).toEqual([]);
    expect(result.videos).toEqual([]);
    // A persisted array is left untouched (not clobbered to []).
    expect(result.skills).toEqual(['zari']);
  });

  it('stamps the seller verified marker from their allowances (M2.3)', async () => {
    const pub = { userId: '6a0a8f515ea9af111dd403bd', visibility: 'public' };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(true),
    );
    const result = await svc.getPublicByUserId('6a0a8f515ea9af111dd403bd');
    expect(result.verified).toBe(true);
  });

  it('404s an unknown / non-public profile', async () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getPublicByUserId('6a0a8f515ea9af111dd403bd')).rejects.toThrow(
      'Profile not found',
    );
  });

  it('404s a malformed id without hitting the database', async () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getPublicByUserId('not-an-id')).rejects.toThrow('Profile not found');
  });

  it('404s an orphaned profile whose owning user was deleted (userId populates null)', async () => {
    // A `ConnectProfile` row that outlived its `User`: the profile doc matched
    // (public) but `populate('userId')` resolved to null. Must 404, not return
    // a 200 with `userId: null` (which crashed the web profile pages).
    const orphan = { userId: null, visibility: 'public' };
    const svc = new ConnectProfileService(
      mockModel(orphan).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getPublicByUserId('6a0a8f515ea9af111dd403bd')).rejects.toThrow(
      'Profile not found',
    );
  });
});

describe('ConnectProfileService.getPublicByUserId — audience trim', () => {
  const subject = '6a0a8f515ea9af111dd403bd';
  const viewer = '6a0a8f515ea9af111dd403be';

  /**
   * Minimal `Connection` model mock — `findOne(...).lean().exec()` resolves the
   * given row (truthy = the pair is connected, null = not connected). Used to
   * drive the trimByAudience branch in the public read.
   */
  function mockConnectionModel(connected: boolean) {
    const chain = {
      select: vi.fn(() => chain),
      lean: vi.fn(() => chain),
      exec: () => Promise.resolve(connected ? { _id: 'x' } : null),
    };
    return { findOne: vi.fn(() => chain) } as unknown as any;
  }

  it('hides a network-audience intent from a non-connection viewer', async () => {
    const pub = {
      userId: subject,
      visibility: 'public',
      openTo: { work: false, hiring: true, deals: false, customOrders: false },
      openToDetails: { hiring: { detail: 'Multi-head operators', audience: 'network' } },
    };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      mockConnectionModel(false),
    );
    const result = await svc.getPublicByUserId(subject, viewer);
    expect(result.openTo.hiring).toBe(false);
    expect((result.openToDetails as Record<string, unknown>).hiring).toBeUndefined();
  });

  it('hides a network-audience intent from a logged-out viewer (no viewerUserId)', async () => {
    const pub = {
      userId: subject,
      visibility: 'public',
      openTo: { work: false, hiring: true, deals: false, customOrders: false },
      openToDetails: { hiring: { detail: 'Multi-head operators', audience: 'network' } },
    };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      mockConnectionModel(false),
    );
    const result = await svc.getPublicByUserId(subject);
    expect(result.openTo.hiring).toBe(false);
    expect((result.openToDetails as Record<string, unknown>).hiring).toBeUndefined();
  });

  it('keeps an all-audience intent visible for any viewer', async () => {
    const pub = {
      userId: subject,
      visibility: 'public',
      openTo: { work: false, hiring: false, deals: true, customOrders: false },
      openToDetails: { deals: { detail: 'Bulk fabric', audience: 'all' } },
    };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      mockConnectionModel(false),
    );
    const result = await svc.getPublicByUserId(subject, viewer);
    expect(result.openTo.deals).toBe(true);
    expect((result.openToDetails as Record<string, unknown>).deals).toEqual({
      detail: 'Bulk fabric',
      audience: 'all',
    });
  });

  it('shows a network-audience intent to a first-degree connection', async () => {
    const pub = {
      userId: subject,
      visibility: 'public',
      openTo: { work: false, hiring: true, deals: false, customOrders: false },
      openToDetails: { hiring: { detail: 'Multi-head operators', audience: 'network' } },
    };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      mockConnectionModel(true),
    );
    const result = await svc.getPublicByUserId(subject, viewer);
    expect(result.openTo.hiring).toBe(true);
    expect((result.openToDetails as Record<string, unknown>).hiring).toEqual({
      detail: 'Multi-head operators',
      audience: 'network',
    });
  });

  it('shows a network-audience intent to the subject themselves (self view)', async () => {
    const pub = {
      userId: subject,
      visibility: 'public',
      openTo: { work: false, hiring: true, deals: false, customOrders: false },
      openToDetails: { hiring: { detail: 'Multi-head operators', audience: 'network' } },
    };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      mockConnectionModel(false),
    );
    const result = await svc.getPublicByUserId(subject, subject);
    expect(result.openTo.hiring).toBe(true);
    expect((result.openToDetails as Record<string, unknown>).hiring).toBeDefined();
  });
});

describe('ConnectProfileService.update', () => {
  const userId = '6a0a8f515ea9af111dd403bd';

  /** A profile-shaped mock document exposing Mongoose `set` / `save`. */
  function mockDoc() {
    const fields = {
      headline: '',
      bio: '',
      banner: '',
      skills: [] as string[],
      portfolio: [] as unknown[],
      experience: [] as unknown[],
      rateCard: undefined as unknown,
    };
    return Object.assign(fields, {
      set: vi.fn(),
      save: vi.fn(() => Promise.resolve()),
    });
  }

  it('applies updatable fields — including contactPreference — then recomputes strength and saves', async () => {
    const doc = mockDoc();
    const svc = new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      undefined,
      undefined,
      undefined, // storefrontModel (ADR-0004 erasure cascade; unused here)
      // Media-ownership guard stub — update() now enforces media ownership.
      {
        assertOwnedMedia: () => Promise.resolve(),
        assertOwnedSingle: () => Promise.resolve(),
      } as any,
    );

    await svc.update(userId, {
      headline: 'Zari karigar',
      contactPreference: 'phone',
    });

    expect(doc.set).toHaveBeenCalledWith('headline', 'Zari karigar');
    expect(doc.set).toHaveBeenCalledWith('contactPreference', 'phone');
    expect(doc.set).toHaveBeenCalledWith('strength', expect.any(Number));
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('skips fields absent from the update DTO', async () => {
    const doc = mockDoc();
    const svc = new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      undefined,
      undefined,
      undefined, // storefrontModel (ADR-0004 erasure cascade; unused here)
      // Media-ownership guard stub — update() now enforces media ownership.
      {
        assertOwnedMedia: () => Promise.resolve(),
        assertOwnedSingle: () => Promise.resolve(),
      } as any,
    );

    await svc.update(userId, { headline: 'Only this' });

    const setKeys = doc.set.mock.calls.map((call) => call[0]);
    expect(setKeys).toContain('headline');
    expect(setKeys).not.toContain('bio');
    expect(setKeys).not.toContain('contactPreference');
  });

  it('persists openToDetails on update', async () => {
    // The mock document's `set` is a no-op spy, so assert the field was routed
    // through `set` (it is in UPDATABLE_FIELDS) rather than reading it back.
    const doc = mockDoc();
    const svc = new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      undefined,
      undefined,
      undefined, // storefrontModel (ADR-0004 erasure cascade; unused here)
      // Media-ownership guard stub — update() now enforces media ownership.
      {
        assertOwnedMedia: () => Promise.resolve(),
        assertOwnedSingle: () => Promise.resolve(),
      } as any,
    );

    await svc.update(userId, {
      openTo: { hiring: true },
      openToDetails: { hiring: { detail: 'Multi-head operators', audience: 'all' } },
    } as any);

    expect(doc.set).toHaveBeenCalledWith('openTo', { hiring: true });
    expect(doc.set).toHaveBeenCalledWith('openToDetails', {
      hiring: { detail: 'Multi-head operators', audience: 'all' },
    });
  });
});

describe('ConnectProfileService.update — broker flag (Broker badge, Slice 1)', () => {
  const userId = '6a0a8f515ea9af111dd403bd';

  /** Media-ownership guard stub (broker has no media; the guard only sees
   *  banner/portfolio, both empty here). Mirrors the training-guard stub. */
  const mediaStub = () =>
    ({
      assertOwnedMedia: () => Promise.resolve(),
      assertOwnedSingle: () => Promise.resolve(),
    }) as any;

  /**
   * A profile-shaped mock document whose `set(key, value)` ACTUALLY writes onto
   * the doc, so the brokerSince false→true stamp logic (which reads
   * `profile.isBroker` / `profile.brokerSince`) can be asserted by inspecting
   * what `set` was called with.
   */
  function mockBrokerDoc(over: { isBroker?: boolean; brokerSince?: Date | null } = {}) {
    const self: any = {
      headline: '',
      bio: '',
      banner: '',
      skills: [] as string[],
      portfolio: [] as unknown[],
      experience: [] as unknown[],
      rateCard: undefined as unknown,
      isBroker: over.isBroker ?? false,
      brokerSince: over.brokerSince ?? null,
    };
    self.set = vi.fn((key: string, value: unknown) => {
      self[key] = value;
    });
    self.save = vi.fn(() => Promise.resolve());
    return self;
  }

  function build(doc: ReturnType<typeof mockBrokerDoc>) {
    return new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      undefined,
      undefined,
      undefined, // storefrontModel (ADR-0004 erasure cascade; unused here)
      mediaStub(),
    );
  }

  it('persists isBroker and stamps brokerSince on the first false→true flip', async () => {
    const doc = mockBrokerDoc({ isBroker: false, brokerSince: null });
    const svc = build(doc);

    await svc.update(userId, { isBroker: true } as any);

    expect(doc.set).toHaveBeenCalledWith('isBroker', true);
    expect(doc.set).toHaveBeenCalledWith('brokerSince', expect.any(Date));
  });

  it('does NOT re-stamp brokerSince when it is already set', async () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const doc = mockBrokerDoc({ isBroker: true, brokerSince: since });
    const svc = build(doc);

    await svc.update(userId, { isBroker: true } as any);

    const setKeys = doc.set.mock.calls.map((c: any[]) => c[0]);
    expect(setKeys).not.toContain('brokerSince');
    expect(doc.brokerSince).toBe(since);
  });

  it('does not stamp brokerSince when turning the flag OFF', async () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const doc = mockBrokerDoc({ isBroker: true, brokerSince: since });
    const svc = build(doc);

    await svc.update(userId, { isBroker: false } as any);

    expect(doc.set).toHaveBeenCalledWith('isBroker', false);
    const setKeys = doc.set.mock.calls.map((c: any[]) => c[0]);
    expect(setKeys).not.toContain('brokerSince');
    // brokerSince is never cleared on toggle-off (track record preserved).
    expect(doc.brokerSince).toBe(since);
  });

  it('leaves isBroker untouched (no set) when the patch omits it', async () => {
    const doc = mockBrokerDoc({ isBroker: false });
    const svc = build(doc);

    await svc.update(userId, { headline: 'just a headline' } as any);

    const setKeys = doc.set.mock.calls.map((c: any[]) => c[0]);
    expect(setKeys).not.toContain('isBroker');
    expect(setKeys).not.toContain('brokerSince');
  });
});

describe('ConnectProfileService.getPublicByUserId — broker flag (Broker badge, Slice 1)', () => {
  const subject = '6a0a8f515ea9af111dd403bd';

  it('exposes isBroker on the public read so the badge renders logged-out', async () => {
    const pub = { userId: subject, visibility: 'public', isBroker: true };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.getPublicByUserId(subject);
    expect((result as Record<string, unknown>).isBroker).toBe(true);
  });
});

describe('ConnectProfileService.update — training write-guard (Institutes Phase 2)', () => {
  const userId = '6a0a8f515ea9af111dd403bd';
  const instituteA = '6a0a8f515ea9af111dd40401';
  const instituteB = '6a0a8f515ea9af111dd40402';
  const confirmerId = '6a0a8f515ea9af111dd40500';

  /** Media-ownership guard stub (training has no media beyond the certificate URL,
   *  which is validated at the DTO; the guard only sees banner/portfolio here). */
  const mediaStub = () =>
    ({
      assertOwnedMedia: () => Promise.resolve(),
      assertOwnedSingle: () => Promise.resolve(),
    }) as any;

  /**
   * A profile-shaped mock document carrying a PRIOR training list + Mongoose
   * `set` / `save`. `set('training', value)` records what the service decided to
   * persist so the test can assert the reconciled output directly.
   */
  function mockTrainingDoc(prior: any[] = []) {
    const fields = {
      headline: '',
      bio: '',
      banner: '',
      skills: [] as string[],
      portfolio: [] as unknown[],
      experience: [] as unknown[],
      training: prior,
      rateCard: undefined as unknown,
    };
    return Object.assign(fields, {
      set: vi.fn(),
      save: vi.fn(() => Promise.resolve()),
    });
  }

  function build(doc: ReturnType<typeof mockTrainingDoc>) {
    return new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      undefined,
      undefined,
      undefined, // storefrontModel (ADR-0004 erasure cascade; unused here)
      mediaStub(),
    );
  }

  /** Pull the value the service routed through `set('training', ...)`. */
  function persistedTraining(doc: ReturnType<typeof mockTrainingDoc>): any[] {
    const call = doc.set.mock.calls.find((c: any[]) => c[0] === 'training');
    expect(call).toBeDefined();
    return call[1] as any[];
  }

  it('forces a NEW item that tries confirmStatus=confirmed down to self, with a generated id', async () => {
    const doc = mockTrainingDoc([]); // no prior credentials
    const svc = build(doc);

    await svc.update(userId, {
      // A student trying to forge a confirmation on a brand-new credential.
      training: [
        {
          instituteName: 'Surat Stitch Academy',
          companyPageId: instituteA,
          confirmStatus: 'confirmed',
        },
      ],
    } as any);

    const [row] = persistedTraining(doc);
    expect(row.confirmStatus).toBe('self');
    expect(row.confirmedAt).toBeNull();
    expect(row.confirmedByUserId).toBeNull();
    // A NEW item gets a server-assigned 24-hex ObjectId id.
    expect(typeof row.id).toBe('string');
    expect(row.id).toMatch(/^[a-f0-9]{24}$/);
  });

  it('forces a NEW item that tries confirmStatus=declined down to self', async () => {
    const doc = mockTrainingDoc([]);
    const svc = build(doc);

    await svc.update(userId, {
      training: [
        { instituteName: 'Academy', companyPageId: instituteA, confirmStatus: 'declined' },
      ],
    } as any);

    const [row] = persistedTraining(doc);
    expect(row.confirmStatus).toBe('self');
  });

  it('promotes a NEW item with a linked institute + pending to pending (the student request-to-confirm)', async () => {
    const doc = mockTrainingDoc([]);
    const svc = build(doc);

    await svc.update(userId, {
      training: [{ instituteName: 'Academy', companyPageId: instituteA, confirmStatus: 'pending' }],
    } as any);

    const [row] = persistedTraining(doc);
    expect(row.confirmStatus).toBe('pending');
  });

  it('keeps pending as self when NO institute is linked (pending needs a target)', async () => {
    const doc = mockTrainingDoc([]);
    const svc = build(doc);

    await svc.update(userId, {
      training: [{ instituteName: 'Self taught', confirmStatus: 'pending' }],
    } as any);

    const [row] = persistedTraining(doc);
    expect(row.confirmStatus).toBe('self');
  });

  it('keeps a prior-confirmed credential confirmed (and preserves confirmedAt/By) even though the student sent self', async () => {
    const trainingId = '6a0a8f515ea9af111dd40999';
    const confirmedAt = new Date('2026-06-01T00:00:00.000Z');
    const doc = mockTrainingDoc([
      {
        id: trainingId,
        instituteName: 'Surat Stitch Academy',
        companyPageId: instituteA,
        confirmStatus: 'confirmed',
        confirmedAt,
        confirmedByUserId: confirmerId,
        shareWithInstitute: false,
      },
    ]);
    const svc = build(doc);

    // The student PATCHes the SAME credential (same id, same institute) but tries
    // to send self + flips their opt-in on.
    await svc.update(userId, {
      training: [
        {
          id: trainingId,
          instituteName: 'Surat Stitch Academy',
          companyPageId: instituteA,
          confirmStatus: 'self',
          shareWithInstitute: true,
        },
      ],
    } as any);

    const [row] = persistedTraining(doc);
    expect(row.id).toBe(trainingId);
    // Institute's decision is authoritative — stays confirmed.
    expect(row.confirmStatus).toBe('confirmed');
    // Confirm metadata preserved verbatim.
    expect(row.confirmedAt).toBe(confirmedAt);
    expect(String(row.confirmedByUserId)).toBe(confirmerId);
    // The student DOES control their own opt-in.
    expect(row.shareWithInstitute).toBe(true);
  });

  it('keeps a prior-declined credential declined when the student re-submits it unchanged', async () => {
    const trainingId = '6a0a8f515ea9af111dd40998';
    const doc = mockTrainingDoc([
      {
        id: trainingId,
        instituteName: 'Academy',
        companyPageId: instituteA,
        confirmStatus: 'declined',
        confirmedAt: new Date('2026-05-01T00:00:00.000Z'),
        confirmedByUserId: confirmerId,
      },
    ]);
    const svc = build(doc);

    await svc.update(userId, {
      training: [
        {
          id: trainingId,
          instituteName: 'Academy',
          companyPageId: instituteA,
          confirmStatus: 'self',
        },
      ],
    } as any);

    const [row] = persistedTraining(doc);
    expect(row.confirmStatus).toBe('declined');
  });

  it('resets a prior-confirmed credential to self and clears confirm metadata when the linked institute changes', async () => {
    const trainingId = '6a0a8f515ea9af111dd40997';
    const doc = mockTrainingDoc([
      {
        id: trainingId,
        instituteName: 'Surat Stitch Academy',
        companyPageId: instituteA,
        confirmStatus: 'confirmed',
        confirmedAt: new Date('2026-06-01T00:00:00.000Z'),
        confirmedByUserId: confirmerId,
      },
    ]);
    const svc = build(doc);

    // The student re-links the SAME credential id to a DIFFERENT institute.
    await svc.update(userId, {
      training: [
        {
          id: trainingId,
          instituteName: 'Surat Stitch Academy',
          companyPageId: instituteB, // re-linked
          confirmStatus: 'self',
        },
      ],
    } as any);

    const [row] = persistedTraining(doc);
    expect(row.confirmStatus).toBe('self');
    expect(row.confirmedAt).toBeNull();
    expect(row.confirmedByUserId).toBeNull();
    // The id is preserved across the edit (same credential, new link).
    expect(row.id).toBe(trainingId);
  });

  it('assigns a fresh id when the student sends an UNKNOWN id (cannot adopt a stranger credential)', async () => {
    const doc = mockTrainingDoc([]); // no prior credentials at all
    const svc = build(doc);

    await svc.update(userId, {
      training: [
        // An id the prior list never had: treated as NEW, status re-derived.
        {
          id: 'deadbeefdeadbeefdeadbeef',
          instituteName: 'Academy',
          companyPageId: instituteA,
          confirmStatus: 'confirmed',
        },
      ],
    } as any);

    const [row] = persistedTraining(doc);
    expect(row.id).not.toBe('deadbeefdeadbeefdeadbeef');
    expect(row.id).toMatch(/^[a-f0-9]{24}$/);
    expect(row.confirmStatus).toBe('self');
    expect(row.confirmedAt).toBeNull();
    expect(row.confirmedByUserId).toBeNull();
  });

  it('clears the training list on an explicit empty array', async () => {
    const doc = mockTrainingDoc([
      { id: '6a0a8f515ea9af111dd40996', instituteName: 'Academy', confirmStatus: 'self' },
    ]);
    const svc = build(doc);

    await svc.update(userId, { training: [] } as any);

    expect(persistedTraining(doc)).toEqual([]);
  });

  it('leaves training untouched (no set) when the patch omits it', async () => {
    const doc = mockTrainingDoc([
      { id: '6a0a8f515ea9af111dd40995', instituteName: 'Academy', confirmStatus: 'confirmed' },
    ]);
    const svc = build(doc);

    await svc.update(userId, { headline: 'just a headline' } as any);

    const setKeys = doc.set.mock.calls.map((c: any[]) => c[0]);
    expect(setKeys).not.toContain('training');
  });

  /**
   * A profile-shaped mock doc whose `set('training', value)` ACTUALLY writes the
   * value onto the document AND whose `toObject()` returns the live fields. This
   * lets a test assert the value RETURNED by `update()` (which re-reads via
   * `getOwnForUser` -> `toObject`), not just the value passed to `set('training',
   * ...)`. The plain `mockTrainingDoc` above keeps `set` a no-op spy, so it can
   * only assert the persisted argument, never the returned (projected) body.
   */
  function mockLiveTrainingDoc(prior: any[] = []) {
    const self: any = {
      _id: '6a0a8f515ea9af111dd40000',
      userId,
      headline: '',
      bio: '',
      banner: '',
      skills: [] as string[],
      portfolio: [] as unknown[],
      experience: [] as unknown[],
      training: prior,
      rateCard: undefined as unknown,
    };
    self.set = vi.fn((key: string, value: unknown) => {
      self[key] = value;
    });
    self.save = vi.fn(() => Promise.resolve());
    self.toObject = () => ({
      _id: self._id,
      userId: self.userId,
      training: self.training,
    });
    return self;
  }

  it('the value RETURNED by update() strips confirmedByUserId from training (not just the persisted value)', async () => {
    // The doc carries a prior CONFIRMED credential whose confirmedByUserId is the
    // institute-internal pointer. The student re-submits the same credential
    // (same id + institute), so reconciliation keeps it confirmed and preserves
    // the pointer in storage -- but the RETURNED projected body must omit it.
    const trainingId = '6a0a8f515ea9af111dd40aaa';
    const doc = mockLiveTrainingDoc([
      {
        id: trainingId,
        instituteName: 'Surat Stitch Academy',
        companyPageId: instituteA,
        confirmStatus: 'confirmed',
        confirmedAt: new Date('2026-06-01T00:00:00.000Z'),
        confirmedByUserId: confirmerId,
        shareWithInstitute: false,
      },
    ]);
    const svc = build(doc);

    const result = (await svc.update(userId, {
      training: [
        {
          id: trainingId,
          instituteName: 'Surat Stitch Academy',
          companyPageId: instituteA,
          confirmStatus: 'self',
          shareWithInstitute: true,
        },
      ],
    } as any)) as any;

    // The PERSISTED training still carries the confirmation pointer (institute
    // audit trail is retained on disk).
    const [persisted] = persistedTraining(doc);
    expect(persisted.confirmStatus).toBe('confirmed');
    expect(String(persisted.confirmedByUserId)).toBe(confirmerId);

    // The RETURNED projected body exposes the badge fields but NOT the internal
    // confirmedByUserId pointer -- the PATCH response matches the GET read.
    const [row] = (result.training ?? []) as any[];
    expect(row.id).toBe(trainingId);
    expect(row.confirmStatus).toBe('confirmed');
    expect(row.shareWithInstitute).toBe(true);
    expect(row.confirmedByUserId).toBeUndefined();
    // And the company maps the GET read attaches are present on the PATCH body.
    expect(result).toHaveProperty('trainingCompanies');
    expect(result).toHaveProperty('experienceCompanies');
  });

  it('the value RETURNED by update() omits confirmedByUserId for a NEW credential too', async () => {
    const doc = mockLiveTrainingDoc([]);
    const svc = build(doc);

    const result = (await svc.update(userId, {
      training: [{ instituteName: 'Academy', companyPageId: instituteA, confirmStatus: 'pending' }],
    } as any)) as any;

    const [row] = (result.training ?? []) as any[];
    // NEW credential: server-assigned id, pending (linked + requested), and the
    // internal pointer is absent from the returned body.
    expect(row.id).toMatch(/^[a-f0-9]{24}$/);
    expect(row.confirmStatus).toBe('pending');
    expect(row.confirmedByUserId).toBeUndefined();
  });
});

describe('ConnectProfileService.getPublicByUserId — training read projection (Institutes Phase 2)', () => {
  const subject = '6a0a8f515ea9af111dd403bd';

  it('exposes id/confirmStatus/confirmedAt/shareWithInstitute but NOT confirmedByUserId', async () => {
    const confirmedAt = new Date('2026-06-01T00:00:00.000Z');
    const pub = {
      userId: subject,
      visibility: 'public',
      training: [
        {
          id: 'tid-1',
          instituteName: 'Surat Stitch Academy',
          confirmStatus: 'confirmed',
          confirmedAt,
          confirmedByUserId: '6a0a8f515ea9af111dd40500', // institute-internal
          shareWithInstitute: true,
        },
      ],
    };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.getPublicByUserId(subject);
    const [row] = (result.training ?? []) as any[];
    expect(row.id).toBe('tid-1');
    expect(row.confirmStatus).toBe('confirmed');
    expect(row.confirmedAt).toBe(confirmedAt);
    expect(row.shareWithInstitute).toBe(true);
    // The institute-internal audit pointer is never leaked publicly.
    expect(row.confirmedByUserId).toBeUndefined();
  });
});

describe('ConnectProfileService.getOwnForUser — training read projection (Institutes Phase 2)', () => {
  const userId = '6a0a8f515ea9af111dd403bd';

  it('exposes the confirm-badge fields but strips confirmedByUserId on the owner read too', async () => {
    const doc = {
      userId,
      training: [
        {
          id: 'tid-9',
          instituteName: 'Academy',
          confirmStatus: 'pending',
          confirmedAt: null,
          confirmedByUserId: '6a0a8f515ea9af111dd40500',
          shareWithInstitute: false,
        },
      ],
      toObject() {
        return { userId, training: this.training };
      },
    };
    const svc = new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.getOwnForUser(userId);
    const [row] = (result.training ?? []) as any[];
    expect(row.id).toBe('tid-9');
    expect(row.confirmStatus).toBe('pending');
    expect(row.shareWithInstitute).toBe(false);
    expect(row.confirmedByUserId).toBeUndefined();
  });
});

describe('ConnectProfileService.update — intro video', () => {
  const userId = '6a0a8f515ea9af111dd403bd';

  /**
   * Media-ownership guard stub for the video path. `assertOwnedMedia` resolves
   * by default (caller owns everything); `getServerVideoDurationByUrl` returns
   * the SERVER-derived clip length (45s, within the 60s upload cap). A test can
   * re-mock either to model a foreign url or a different duration. Mirrors the
   * marketplace listing.service.vitest media mock.
   */
  function mockMedia() {
    return {
      assertOwnedMedia: vi.fn().mockResolvedValue(undefined),
      getServerVideoDurationByUrl: vi.fn().mockResolvedValue(45),
    };
  }

  /** A profile-shaped mock document exposing Mongoose `set` / `save` + `videos`. */
  function mockVideoDoc(
    videos: Array<{ url: string; posterUrl?: string; durationSec?: number }> = [],
  ) {
    const fields = {
      headline: '',
      bio: '',
      banner: '',
      skills: [] as string[],
      portfolio: [] as unknown[],
      experience: [] as unknown[],
      rateCard: undefined as unknown,
      videos,
    };
    return Object.assign(fields, {
      set: vi.fn(),
      save: vi.fn(() => Promise.resolve()),
    });
  }

  function build(doc: ReturnType<typeof mockVideoDoc>, media: ReturnType<typeof mockMedia>) {
    return new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      undefined,
      undefined,
      undefined, // storefrontModel (ADR-0004 erasure cascade; unused here)
      media as any,
    );
  }

  it('persists an owned 45s video and stamps the SERVER-derived durationSec', async () => {
    const doc = mockVideoDoc();
    const media = mockMedia(); // owned upload probed this clip at 45s (within 60s cap)
    const svc = build(doc, media);

    await svc.update(userId, {
      videos: [{ url: 'https://cdn/clip.mp4', posterUrl: 'https://cdn/poster.jpg' }],
    } as any);

    // url + posterUrl both ownership-checked (flattened into one guard call).
    const vidCall = media.assertOwnedMedia.mock.calls.find((c: any[]) =>
      (c[0] as string[]).includes('https://cdn/clip.mp4'),
    );
    expect(vidCall?.[0]).toEqual(
      expect.arrayContaining(['https://cdn/clip.mp4', 'https://cdn/poster.jpg']),
    );
    // The stamped video (server durationSec 45) is routed through `set('videos', ...)`.
    expect(doc.set).toHaveBeenCalledWith('videos', [
      { url: 'https://cdn/clip.mp4', posterUrl: 'https://cdn/poster.jpg', durationSec: 45 },
    ]);
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('rejects a video URL the caller does not own (media-ownership guard throws), no save', async () => {
    const doc = mockVideoDoc();
    const media = mockMedia();
    // The video clip is not owned by the caller (a foreign url).
    media.assertOwnedMedia.mockImplementation((urls: string[]) => {
      if (urls.includes('https://cdn/foreign.mp4')) {
        return Promise.reject(new Error('not yours'));
      }
      return Promise.resolve(undefined);
    });
    const svc = build(doc, media);

    await expect(
      svc.update(userId, { videos: [{ url: 'https://cdn/foreign.mp4' }] } as any),
    ).rejects.toThrow();
    expect(doc.save).not.toHaveBeenCalled();
    // Never derived a duration for an unowned clip.
    expect(media.getServerVideoDurationByUrl).not.toHaveBeenCalled();
  });

  it('keeps the existing video (grandfathered) and re-stamps its server duration', async () => {
    const existingVideo = { url: 'https://cdn/old.mp4', posterUrl: 'https://cdn/oldposter.jpg' };
    const doc = mockVideoDoc([existingVideo]);
    const media = mockMedia();
    media.getServerVideoDurationByUrl.mockResolvedValue(30);
    const svc = build(doc, media);

    await svc.update(userId, { videos: [existingVideo] } as any);

    // The video guard grandfathers the existing clip url + poster (no new
    // ownership record required to keep it).
    const vidCall = media.assertOwnedMedia.mock.calls.find((c: any[]) =>
      (c[0] as string[]).includes('https://cdn/old.mp4'),
    );
    expect(vidCall?.[2]?.grandfatheredUrls).toEqual(
      expect.arrayContaining(['https://cdn/old.mp4', 'https://cdn/oldposter.jpg']),
    );
    expect(doc.set).toHaveBeenCalledWith('videos', [
      { url: 'https://cdn/old.mp4', posterUrl: 'https://cdn/oldposter.jpg', durationSec: 30 },
    ]);
  });

  it('leaves the existing video untouched when videos is omitted from the patch', async () => {
    const doc = mockVideoDoc([{ url: 'https://cdn/keep.mp4', durationSec: 20 }]);
    const media = mockMedia();
    const svc = build(doc, media);

    await svc.update(userId, { headline: 'just a headline change' } as any);

    const setKeys = doc.set.mock.calls.map((call) => call[0]);
    expect(setKeys).not.toContain('videos');
    // No video work happens when `videos` is absent from the patch.
    expect(media.getServerVideoDurationByUrl).not.toHaveBeenCalled();
  });
});

describe('ConnectProfileService.getEntryState', () => {
  const userId = '6a0a8f515ea9af111dd403bd';

  it('reports no access for a user without connectEnabled', async () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel({ connectEnabled: false }),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getEntryState(userId)).resolves.toEqual({
      connectEnabled: false,
      onboarded: false,
      policyAccepted: false,
    });
  });

  it('treats an absent connectEnabled flag as enabled (default-on, schema default true)', async () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      // No connectEnabled key at all - an older / seeded / not-backfilled doc.
      // The schema default is `true` and Connect is default-on, so this user
      // must reach Connect, not the "coming soon" dead-end.
      mockUserModel({}),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getEntryState(userId)).resolves.toEqual({
      connectEnabled: true,
      onboarded: false,
      policyAccepted: false,
    });
  });

  it('reports no access when the user record is missing', async () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getEntryState(userId)).resolves.toEqual({
      connectEnabled: false,
      onboarded: false,
      policyAccepted: false,
    });
  });

  it('reports onboarded for a connectEnabled user with a stamped profile', async () => {
    const svc = new ConnectProfileService(
      mockModel({ onboardedAt: new Date() }).model,
      mockUserModel({ connectEnabled: true }),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getEntryState(userId)).resolves.toEqual({
      connectEnabled: true,
      onboarded: true,
      policyAccepted: false,
    });
  });

  it('reports not-onboarded for a connectEnabled user with no profile yet', async () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel({ connectEnabled: true }),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getEntryState(userId)).resolves.toEqual({
      connectEnabled: true,
      onboarded: false,
      policyAccepted: false,
    });
  });

  it('reports policyAccepted=true when connectPolicyAcceptedAt is stamped', async () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel({ connectEnabled: true, connectPolicyAcceptedAt: new Date() }),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getEntryState(userId)).resolves.toEqual({
      connectEnabled: true,
      onboarded: false,
      policyAccepted: true,
    });
  });
});

describe('ConnectProfileService.acceptPolicy', () => {
  const userId = '6a0a8f515ea9af111dd403bd';

  it('returns the acceptedAt timestamp after stamping', async () => {
    const stampedAt = new Date('2026-05-19T10:00:00.000Z');
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel({ connectPolicyAcceptedAt: stampedAt }),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.acceptPolicy(userId);
    expect(result).toHaveProperty('acceptedAt');
    expect(result.acceptedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — falls back to now when user record is missing', async () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.acceptPolicy(userId);
    expect(result).toHaveProperty('acceptedAt');
    expect(result.acceptedAt).toBeInstanceOf(Date);
  });
});

describe('ConnectProfileService.completeOnboarding', () => {
  const userId = '6a0a8f515ea9af111dd403bd';

  function onboardDoc(onboardedAt: Date | null = null) {
    return Object.assign(
      {
        onboardedAt,
        openTo: { work: false, hiring: false, deals: false, customOrders: false },
      },
      { set: vi.fn(), save: vi.fn(() => Promise.resolve()) },
    );
  }

  it('stamps onboardedAt and sets a karigar open-to-work', async () => {
    const doc = onboardDoc();
    const svc = new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );

    await svc.completeOnboarding(userId, 'karigar');

    expect(doc.set).toHaveBeenCalledWith('onboardedAt', expect.any(Date));
    expect(doc.set).toHaveBeenCalledWith('openTo.work', true);
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('persists the intent on onboardingIntent for every persona', async () => {
    const doc = onboardDoc();
    const svc = new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );

    await svc.completeOnboarding(userId, 'workshop_owner');

    expect(doc.set).toHaveBeenCalledWith('onboardingIntent', 'workshop_owner');
  });

  it('stamps onboardedAt without the open-to-work pre-set for a non-karigar', async () => {
    const doc = onboardDoc();
    const svc = new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );

    await svc.completeOnboarding(userId, 'buyer');

    expect(doc.set).toHaveBeenCalledWith('onboardedAt', expect.any(Date));
    expect(doc.set).toHaveBeenCalledWith('onboardingIntent', 'buyer');
    const setKeys = doc.set.mock.calls.map((call) => call[0]);
    expect(setKeys).not.toContain('openTo.work');
  });

  it('does not overwrite an already-stamped onboardedAt', async () => {
    const doc = onboardDoc(new Date('2025-01-01'));
    const svc = new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );

    await svc.completeOnboarding(userId, 'explorer');

    const setKeys = doc.set.mock.calls.map((call) => call[0]);
    expect(setKeys).not.toContain('onboardedAt');
    // intent is always persisted, even on re-onboarding
    expect(doc.set).toHaveBeenCalledWith('onboardingIntent', 'explorer');
  });
});

describe('deriveOpenStatus', () => {
  it('hiring + all -> hiring', () => {
    expect(deriveOpenStatus({ hiring: true }, { hiring: { audience: 'all' } })).toBe('hiring');
  });
  it('work + all -> work', () => {
    expect(deriveOpenStatus({ work: true }, { work: { audience: 'all' } })).toBe('work');
  });
  it('work with no details (audience defaults to all) -> work', () => {
    expect(deriveOpenStatus({ work: true }, undefined)).toBe('work');
  });
  it('hiring + network -> null (does not leak into broad lists)', () => {
    expect(deriveOpenStatus({ hiring: true }, { hiring: { audience: 'network' } })).toBe(null);
  });
  it('work + network -> null', () => {
    expect(deriveOpenStatus({ work: true }, { work: { audience: 'network' } })).toBe(null);
  });
  it('both off -> null', () => {
    expect(deriveOpenStatus({ work: false, hiring: false }, undefined)).toBe(null);
  });
  it('hiring beats work when both are set (mutually exclusive in practice)', () => {
    expect(
      deriveOpenStatus(
        { work: true, hiring: true },
        { work: { audience: 'all' }, hiring: { audience: 'all' } },
      ),
    ).toBe('hiring');
  });
  it('undefined inputs -> null', () => {
    expect(deriveOpenStatus(undefined, undefined)).toBe(null);
  });
});

describe('ConnectProfileService.getPeopleByIds', () => {
  const u1 = '6a0a8f515ea9af111dd403b1';
  const u2 = '6a0a8f515ea9af111dd403b2';
  const u3 = '6a0a8f515ea9af111dd403b3';

  /**
   * `Model<User>` mock for the `find(...).select(...).lean().exec()` batch path.
   * Resolves the given user docs (each keyed by `_id`).
   */
  function mockUserFindModel(
    users: Array<{ _id: unknown; name?: string; profilePicture?: string }>,
  ): UserModelArg {
    const chain = {
      select: vi.fn(() => chain),
      lean: vi.fn(() => chain),
      exec: () => Promise.resolve(users),
    };
    return { find: vi.fn(() => chain) } as unknown as UserModelArg;
  }

  it('getPeopleByIds derives openStatus (hiring>work, network-scoped -> null)', async () => {
    const users = [
      { _id: u1, name: 'Anita', profilePicture: 'a.jpg' },
      { _id: u2, name: 'Bharat', profilePicture: null as unknown as string },
      { _id: u3, name: 'Chetan' },
    ];
    const profiles = [
      {
        userId: u1,
        headline: 'Hiring lead',
        openTo: { hiring: true },
        openToDetails: { hiring: { audience: 'all' } },
      },
      { userId: u2, headline: 'Karigar', openTo: { work: true } },
      {
        userId: u3,
        headline: 'Owner',
        openTo: { hiring: true },
        openToDetails: { hiring: { audience: 'network' } },
      },
    ];
    const svc = new ConnectProfileService(
      mockModel(profiles).model,
      mockUserFindModel(users),
      mockEmitter(),
      mockAllowances(),
    );
    const refs = await svc.getPeopleByIds([u1, u2, u3]);
    const byId = Object.fromEntries(refs.map((r) => [r.userId, r.openStatus]));
    expect(byId[u1]).toBe('hiring');
    expect(byId[u2]).toBe('work');
    expect(byId[u3]).toBe(null);
  });

  it('defaults openStatus to null for a user with no profile row', async () => {
    const users = [{ _id: u1, name: 'Anita', profilePicture: 'a.jpg' }];
    const svc = new ConnectProfileService(
      mockModel([]).model, // no profiles match
      mockUserFindModel(users),
      mockEmitter(),
      mockAllowances(),
    );
    const refs = await svc.getPeopleByIds([u1]);
    expect(refs[0].openStatus).toBe(null);
  });
});

describe('ConnectProfileService.getPublicByUserId — rate-card login gate', () => {
  const subject = '6a0a8f515ea9af111dd403bd';
  const viewer = '6a0a8f515ea9af111dd403be';

  it('strips the rate card for a logged-out viewer (no viewerUserId)', async () => {
    const pub = {
      userId: subject,
      visibility: 'public',
      rateCard: { dailyWage: 90000, pieceRate: 1200, monthly: 2500000 },
    };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.getPublicByUserId(subject);
    expect(result.rateCard).toBeUndefined();
  });

  it('keeps the rate card for a signed-in viewer', async () => {
    const card = { dailyWage: 90000, pieceRate: 1200, monthly: 2500000 };
    const pub = { userId: subject, visibility: 'public', rateCard: card };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.getPublicByUserId(subject, viewer);
    expect(result.rateCard).toEqual(card);
  });
});

describe('ConnectProfileService.getPublicPeopleByIds', () => {
  const u1 = '6a0a8f515ea9af111dd403b1';
  const u2 = '6a0a8f515ea9af111dd403b2';

  function mockUserFindModel(
    users: Array<{ _id: unknown; name?: string; profilePicture?: string }>,
  ): UserModelArg {
    const chain = {
      select: vi.fn(() => chain),
      lean: vi.fn(() => chain),
      exec: () => Promise.resolve(users),
    };
    return { find: vi.fn(() => chain) } as unknown as UserModelArg;
  }

  it('maps public-profile users to identity refs (name/avatar/headline/openStatus)', async () => {
    const users = [
      { _id: u1, name: 'Anita', profilePicture: 'a.jpg' },
      { _id: u2, name: 'Bharat' },
    ];
    const profiles = [
      {
        userId: u1,
        headline: 'Hiring lead',
        openTo: { hiring: true },
        openToDetails: { hiring: { audience: 'all' } },
      },
      { userId: u2, headline: 'Karigar', openTo: { work: true } },
    ];
    const svc = new ConnectProfileService(
      mockModel(profiles).model,
      mockUserFindModel(users),
      mockEmitter(),
      mockAllowances(),
    );
    const refs = await svc.getPublicPeopleByIds([u1, u2]);
    const byId = Object.fromEntries(refs.map((r) => [r.userId, r]));
    expect(byId[u1]).toMatchObject({ name: 'Anita', avatar: 'a.jpg', openStatus: 'hiring' });
    expect(byId[u2]).toMatchObject({ name: 'Bharat', avatar: null, headline: 'Karigar' });
  });

  it('returns nothing when no public profile matches (non-public ids never resolve)', async () => {
    const svc = new ConnectProfileService(
      mockModel([]).model, // visibility: 'public' filter yields no rows
      mockUserFindModel([{ _id: u1, name: 'Anita' }]),
      mockEmitter(),
      mockAllowances(),
    );
    const refs = await svc.getPublicPeopleByIds([u1]);
    expect(refs).toEqual([]);
  });

  it('returns [] for an empty id list without touching the database', async () => {
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getPublicPeopleByIds([])).resolves.toEqual([]);
  });
});

describe('ConnectProfileService.getPublicByUserId — experience companies', () => {
  const subject = '6a0a8f515ea9af111dd403bd';
  const pubId = '6a0a8f515ea9af111dd40301';
  const hiddenId = '6a0a8f515ea9af111dd40302';

  /**
   * Minimal `Model<CompanyPage>` mock for the experience-company resolver. The
   * service queries `find({ _id: { $in }, visibility: 'public' }).select().lean()`,
   * so this returns ONLY the public page rows (the hidden/missing id is dropped
   * by the source, mirroring the real `visibility: 'public'` filter). `_id`
   * comparison is by string so the test does not need real ObjectIds.
   */
  function mockCompanyPageModel(publicRows: Array<{ _id: string; name: string; slug: string }>) {
    const chain = {
      select: vi.fn(() => chain),
      lean: vi.fn(() => chain),
      exec: () => Promise.resolve(publicRows),
    };
    return { find: vi.fn(() => chain) } as unknown as any;
  }

  it('attaches experienceCompanies for linked public pages, omits hidden/missing', async () => {
    const pub = {
      userId: subject,
      visibility: 'public',
      experience: [
        { workshop: 'A', companyPageId: pubId },
        { workshop: 'B', companyPageId: hiddenId },
        { workshop: 'C' },
      ],
    };
    // The company source resolves ONLY the public page (hidden/missing dropped).
    const companyModel = mockCompanyPageModel([
      { _id: pubId, name: 'Anat Textiles', slug: 'anat' },
    ]);
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      undefined,
      companyModel,
    );
    const result = await svc.getPublicByUserId(subject);
    expect(result.experienceCompanies[String(pubId)]?.slug).toBeTruthy();
    expect(result.experienceCompanies[String(hiddenId)]).toBeUndefined();
  });

  it('returns an empty map when the company model is absent (degraded boot)', async () => {
    const pub = {
      userId: subject,
      visibility: 'public',
      experience: [{ workshop: 'A', companyPageId: pubId }],
    };
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    const result = await svc.getPublicByUserId(subject);
    expect(result.experienceCompanies).toEqual({});
    expect(result.trainingCompanies).toEqual({});
  });

  it('resolves a training-linked institute into trainingCompanies (Institutes Phase 1)', async () => {
    const pub = {
      userId: subject,
      visibility: 'public',
      training: [
        { instituteName: 'Linked Academy', companyPageId: pubId },
        { instituteName: 'Hidden Academy', companyPageId: hiddenId },
        { instituteName: 'Self Taught' },
      ],
    };
    // Only the public page resolves; the hidden id is dropped by the source.
    const companyModel = mockCompanyPageModel([
      { _id: pubId, name: 'Surat Stitch Academy', slug: 'surat-stitch-academy' },
    ]);
    const svc = new ConnectProfileService(
      mockModel(pub).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      undefined,
      companyModel,
    );
    const result = await svc.getPublicByUserId(subject);
    expect(result.trainingCompanies[String(pubId)]?.slug).toBe('surat-stitch-academy');
    expect(result.trainingCompanies[String(hiddenId)]).toBeUndefined();
    // A self-declared training entry carries NO verified flag (Phase 1 honesty).
    expect((result.training?.[2] as Record<string, unknown>)?.verified).toBeUndefined();
  });
});

describe('ConnectProfileService.getOwnForUser', () => {
  const userId = '6a0a8f515ea9af111dd403bd';
  const pubId = '6a0a8f515ea9af111dd40301';

  function mockCompanyPageModel(publicRows: Array<{ _id: string; name: string; slug: string }>) {
    const chain = {
      select: vi.fn(() => chain),
      lean: vi.fn(() => chain),
      exec: () => Promise.resolve(publicRows),
    };
    return { find: vi.fn(() => chain) } as unknown as any;
  }

  it('attaches experienceCompanies on the owner read (toObject path)', async () => {
    // A Mongoose-doc-like object exposing toObject() — the own read converts to
    // a plain object before attaching the map.
    const doc = {
      userId,
      experience: [{ workshop: 'A', companyPageId: pubId }],
      toObject() {
        return { userId, experience: this.experience };
      },
    };
    const companyModel = mockCompanyPageModel([
      { _id: pubId, name: 'Anat Textiles', slug: 'anat' },
    ]);
    const svc = new ConnectProfileService(
      mockModel(doc).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined,
      undefined,
      companyModel,
    );
    const result = await svc.getOwnForUser(userId);
    expect(result.experienceCompanies[String(pubId)]?.slug).toBe('anat');
  });
});

describe('ConnectProfileService.getFeaturedWorkshops', () => {
  it('returns an empty array — featured workshops move to CompanyPage entities in Phase 6', async () => {
    // Post-reframe stub: a `ConnectProfile` is Person-scoped and carries no
    // workspace ref, so it can no longer identify a "workshop". The method +
    // its Promise-typed signature are kept so the `featured-workshops`
    // endpoint contract holds; the web Day-1 home renders an empty-state.
    const svc = new ConnectProfileService(
      mockModel(null).model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.getFeaturedWorkshops()).resolves.toEqual([]);
  });
});

describe('ConnectProfileService.removeFromConnectForErasure (ADR-0004)', () => {
  const erasedUser = '6a0a8f515ea9af111dd403bd';

  /** Profile model exposing updateOne so we can assert the consent-revoke write. */
  function makeProfileModel() {
    const updateOne = vi.fn(() => ({ exec: () => Promise.resolve({ modifiedCount: 1 }) }));
    return { model: { updateOne } as unknown as Model<ConnectProfile>, updateOne };
  }

  /** Entity model exposing updateMany (CompanyPage / Storefront unlink). */
  function makeEntityModel() {
    const updateMany = vi.fn(() => ({ exec: () => Promise.resolve({ modifiedCount: 2 }) }));
    return { model: { updateMany } as any, updateMany };
  }

  it('revokes consent + hides the profile AND unlinks every owned CompanyPage/Storefront', async () => {
    const profile = makeProfileModel();
    const companyPage = makeEntityModel();
    const storefront = makeEntityModel();
    const svc = new ConnectProfileService(
      profile.model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
      undefined, // reviews
      undefined, // connectionModel
      companyPage.model, // companyPageModel
      storefront.model, // storefrontModel (ADR-0004)
      undefined, // media
    );

    await svc.removeFromConnectForErasure(erasedUser);

    // Profile: visibility hidden + consent revoked in the same write.
    expect(profile.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: expect.anything() }),
      expect.objectContaining({
        $set: expect.objectContaining({
          visibility: 'hidden',
          'erpVerificationConsent.status': 'revoked',
        }),
      }),
    );
    // Both owned-entity collections get their ERP link revoked.
    for (const m of [companyPage, storefront]) {
      expect(m.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ erpWorkspaceId: { $ne: null } }),
        expect.objectContaining({
          $set: expect.objectContaining({ erpWorkspaceId: null, 'erpLink.status': 'revoked' }),
        }),
      );
    }
  });

  it('is a safe no-op for an invalid userId', async () => {
    const profile = makeProfileModel();
    const svc = new ConnectProfileService(
      profile.model,
      mockUserModel(null),
      mockEmitter(),
      mockAllowances(),
    );
    await expect(svc.removeFromConnectForErasure('not-an-id')).resolves.toBeUndefined();
    expect(profile.updateOne).not.toHaveBeenCalled();
  });
});
