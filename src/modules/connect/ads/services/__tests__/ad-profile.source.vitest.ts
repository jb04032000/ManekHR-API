import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectAdProfileSource, ConnectAudienceCounter } from '../ad-profile.source';
import type { AdProfile, TargetingMatchSpec } from '../../lib/targeting';
import { matchesTargeting } from '../../lib/targeting';

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

/** Minimal ConnectProfile-shaped lean doc. */
function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    headline: 'Karigar · 12 yrs',
    skills: ['zari', 'sequins'],
    district: 'Surat',
    onboardingIntent: null as string | null,
    visibility: 'public',
    ...overrides,
  };
}

function makeProfileModel(doc: Record<string, unknown> | null) {
  const exec = vi.fn().mockResolvedValue(doc);
  const lean = vi.fn().mockReturnValue({ exec });
  const findOne = vi.fn().mockReturnValue({ lean });
  return { findOne, lean, exec };
}

function makeCountModel(count: number) {
  const exec = vi.fn().mockResolvedValue(count);
  const countDocuments = vi.fn().mockReturnValue({ exec });
  return { countDocuments, exec };
}

function makeErpLinkService() {
  return {
    getUserStatus: vi.fn().mockResolvedValue({ linked: false, since: null, signals: {} }),
    getErpSummary: vi.fn().mockResolvedValue({ owner: false, karigarCount: 0, payrollPaise: 0 }),
  };
}

// ---------------------------------------------------------------------------
// ConnectAdProfileSource
// ---------------------------------------------------------------------------

describe('ConnectAdProfileSource', () => {
  let source: ConnectAdProfileSource;
  let profileModel: ReturnType<typeof makeProfileModel>;
  let erpLink: ReturnType<typeof makeErpLinkService>;

  beforeEach(() => {
    erpLink = makeErpLinkService();
  });

  it('maps a full ConnectProfile to the correct AdProfile dims', async () => {
    const doc = makeProfile({ onboardingIntent: 'karigar', district: 'Surat', skills: ['zari'] });
    profileModel = makeProfileModel(doc);

    source = new ConnectAdProfileSource(profileModel as never, erpLink as never);

    const result = await source.buildFor('user-1');

    expect(result.role).toBe('karigar');
    expect(result.skills).toEqual(['zari']);
    expect(result.district).toBe('surat');
    expect(result.companySize).toBe('');
    // connectionDegree is always 1 in foundation (see class-level doc)
    expect(result.connectionDegree).toBe(1);
  });

  it('falls back to headline first token when onboardingIntent is null', async () => {
    const doc = makeProfile({
      onboardingIntent: null,
      headline: 'Workshop owner · Surat',
      skills: ['aari'],
    });
    profileModel = makeProfileModel(doc);
    source = new ConnectAdProfileSource(profileModel as never, erpLink as never);

    const result = await source.buildFor('user-1');

    expect(result.role).toBe('workshop');
    expect(result.skills).toEqual(['aari']);
  });

  it('returns all-empty AdProfile with connectionDegree 1 when no profile exists', async () => {
    profileModel = makeProfileModel(null);
    source = new ConnectAdProfileSource(profileModel as never, erpLink as never);

    const result = await source.buildFor('unknown-user');

    expect(result).toEqual({
      role: '',
      skills: [],
      district: '',
      companySize: '',
      connectionDegree: 1,
    });
  });

  it('returns all-empty AdProfile on DB error (graceful degrade)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('mongo down'));
    const lean = vi.fn().mockReturnValue({ exec });
    const findOne = vi.fn().mockReturnValue({ lean });
    source = new ConnectAdProfileSource({ findOne } as never, erpLink as never);

    const result = await source.buildFor('user-1');

    expect(result).toEqual({
      role: '',
      skills: [],
      district: '',
      companySize: '',
      connectionDegree: 1,
    });
  });

  it('returns empty skills when skills array is empty', async () => {
    const doc = makeProfile({ skills: [], onboardingIntent: 'buyer' });
    profileModel = makeProfileModel(doc);
    source = new ConnectAdProfileSource(profileModel as never, erpLink as never);

    const result = await source.buildFor('user-1');

    expect(result.skills).toEqual([]);
    expect(result.role).toBe('buyer');
  });

  it('normalises district (trim + lowercase)', async () => {
    const doc = makeProfile({ district: '  Jetpur  ' });
    profileModel = makeProfileModel(doc);
    source = new ConnectAdProfileSource(profileModel as never, erpLink as never);

    const result = await source.buildFor('user-1');

    expect(result.district).toBe('jetpur');
  });

  it('normalises ALL skills (trim + lowercase), not just the first', async () => {
    const doc = makeProfile({ skills: ['  Weaving ', 'DYEING'] });
    profileModel = makeProfileModel(doc);
    source = new ConnectAdProfileSource(profileModel as never, erpLink as never);

    const result = await source.buildFor('user-1');

    expect(result.skills).toEqual(['weaving', 'dyeing']);
  });

  it('prefers geoDistrictSlug (canonical NAME) over free-text district', async () => {
    // The member picked a State -> District; the slug resolves to the canonical
    // NAME, which is what the matcher recognizes. The stale free-text is ignored.
    const doc = makeProfile({ district: 'old free text', geoDistrictSlug: 'east-godavari' });
    profileModel = makeProfileModel(doc);
    source = new ConnectAdProfileSource(profileModel as never, erpLink as never);

    const result = await source.buildFor('user-1');

    expect(result.district).toBe('east godavari');
  });

  it('falls back to free-text district when geoDistrictSlug is empty/unrecognized', async () => {
    const doc = makeProfile({ district: 'Surat', geoDistrictSlug: '' });
    profileModel = makeProfileModel(doc);
    source = new ConnectAdProfileSource(profileModel as never, erpLink as never);

    const result = await source.buildFor('user-1');

    expect(result.district).toBe('surat');
  });

  it('falls back to free-text when geoDistrictSlug is not a known slug', async () => {
    const doc = makeProfile({ district: 'Surat', geoDistrictSlug: 'not-a-real-slug' });
    profileModel = makeProfileModel(doc);
    source = new ConnectAdProfileSource(profileModel as never, erpLink as never);

    const result = await source.buildFor('user-1');

    expect(result.district).toBe('surat');
  });
});

// ---------------------------------------------------------------------------
// ConnectAudienceCounter
// ---------------------------------------------------------------------------

describe('ConnectAudienceCounter', () => {
  let counter: ConnectAudienceCounter;

  it('returns countDocuments result for a full spec', async () => {
    const model = makeCountModel(120);
    counter = new ConnectAudienceCounter(model as never);

    const spec: TargetingMatchSpec = {
      roles: ['karigar'],
      sectors: ['zari'],
      districts: ['Surat'],
      companySizes: [],
    };

    const result = await counter.countMatching(spec);

    expect(result).toBe(120);
    const callArg = model.countDocuments.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg['visibility']).toBe('public');
    expect(callArg['onboardingIntent']).toEqual({ $in: ['karigar'] });
    expect(callArg['skills']).toEqual({ $in: [/^zari$/i] });
    // District now uses the fallback-aware $or (mirrors matchesTargeting): match
    // the target district OR have a non-canonical (unknown-location) district.
    const or = callArg['$or'] as Array<Record<string, unknown>>;
    expect(Array.isArray(or)).toBe(true);
    expect(or[0]).toEqual({ district: { $in: [/^surat$/i] } });
    expect(or[1]).toHaveProperty('district.$nin');
  });

  it('counts all public profiles when spec is empty (broad reach)', async () => {
    const model = makeCountModel(5000);
    counter = new ConnectAudienceCounter(model as never);

    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: [],
      companySizes: [],
    };

    const result = await counter.countMatching(spec);

    expect(result).toBe(5000);
    // Only visibility filter - no $in dims added
    expect(model.countDocuments).toHaveBeenCalledWith({ visibility: 'public' });
  });

  it('omits onboardingIntent filter when roles is empty', async () => {
    const model = makeCountModel(300);
    counter = new ConnectAudienceCounter(model as never);

    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: ['zari'],
      districts: [],
      companySizes: [],
    };

    await counter.countMatching(spec);

    const callArg = model.countDocuments.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg['onboardingIntent']).toBeUndefined();
    expect(callArg['skills']).toEqual({ $in: [/^zari$/i] });
  });

  it('applies district filter as a fallback-aware $or', async () => {
    const model = makeCountModel(50);
    counter = new ConnectAudienceCounter(model as never);

    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: ['Surat', 'Jetpur'],
      companySizes: [],
    };

    await counter.countMatching(spec);

    const callArg = model.countDocuments.mock.calls[0][0] as Record<string, unknown>;
    // No bare `district` key — it lives inside the $or now.
    expect(callArg['district']).toBeUndefined();
    const or = callArg['$or'] as Array<Record<string, unknown>>;
    expect(or[0]).toEqual({ district: { $in: [/^surat$/i, /^jetpur$/i] } });
    // Second branch: NOT a recognized canonical district (unknown-location).
    const ninBranch = or[1] as { district: { $nin: RegExp[] } };
    expect(Array.isArray(ninBranch.district.$nin)).toBe(true);
    // The canonical recognition set is large (~700 districts) and includes Surat.
    expect(ninBranch.district.$nin.length).toBeGreaterThan(500);
    expect(ninBranch.district.$nin.some((r) => r.test('Surat'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reach estimate <-> delivery matcher consistency (Task 5)
// ---------------------------------------------------------------------------

/**
 * The reach estimate (AudienceService -> ConnectAudienceCounter.countMatching)
 * is a Mongo query, not a literal matchesTargeting() call, so this check proves
 * the query SEMANTICS agree with the delivery matcher for the district fallback:
 * apply the counter's `$or` district filter to in-memory docs and confirm the
 * same docs survive as matchesTargeting() would include.
 */
describe('reach estimate mirrors the delivery matcher (district fallback)', () => {
  function makeCountModel(count: number) {
    const exec = vi.fn().mockResolvedValue(count);
    const countDocuments = vi.fn().mockReturnValue({ exec });
    return { countDocuments, exec };
  }

  /** Does a district value satisfy a single $or branch ($in or $nin of regexes)? */
  function branchMatches(branch: any, district: string): boolean {
    if (branch.district?.$in) return branch.district.$in.some((r: RegExp) => r.test(district));
    if (branch.district?.$nin) return !branch.district.$nin.some((r: RegExp) => r.test(district));
    return false;
  }

  it('counter $or admits exactly the districts matchesTargeting() admits', async () => {
    const model = makeCountModel(0);
    const counter = new ConnectAudienceCounter(model as never);
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: ['Surat'],
      companySizes: [],
    };
    await counter.countMatching(spec);
    const callArg = model.countDocuments.mock.calls[0][0] as Record<string, unknown>;
    const or = callArg['$or'] as any[];

    const cases = [
      'Surat', // targeted, recognized -> include
      'surat', // case-insensitive -> include
      'Rajkot', // recognized, not targeted -> EXCLUDE
      '', // blank, unknown-location -> include
      'Some Unknown Place', // unrecognized -> include (fallback)
    ];

    for (const district of cases) {
      const profile: AdProfile = {
        role: '',
        skills: [],
        district,
        companySize: '',
        connectionDegree: 1,
      };
      const matcherSays = matchesTargeting(spec, profile);
      const counterSays = or.some((b) => branchMatches(b, district));
      expect(counterSays).toBe(matcherSays);
    }
  });
});
