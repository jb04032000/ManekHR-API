import { describe, it, expect } from 'vitest';
import { matchesTargeting, isUnknownLocationDistrictMatch } from '../targeting';
import type { AdProfile, TargetingMatchSpec } from '../targeting';

const baseProfile: AdProfile = {
  role: 'manager',
  skills: ['textile'],
  district: 'surat',
  companySize: '50-200',
  connectionDegree: 2,
};

describe('matchesTargeting', () => {
  it('all constrained dims match -> true', () => {
    const spec: TargetingMatchSpec = {
      roles: ['manager'],
      sectors: ['textile'],
      districts: ['surat'],
      companySizes: ['50-200'],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(true);
  });

  it('one mismatch (role) -> false', () => {
    const spec: TargetingMatchSpec = {
      roles: ['owner'],
      sectors: ['textile'],
      districts: ['surat'],
      companySizes: ['50-200'],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(false);
  });

  it('one mismatch (sector) -> false', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: ['pharma'],
      districts: [],
      companySizes: [],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(false);
  });

  it('one mismatch (district) -> false', () => {
    // baseProfile.district = 'surat' is a RECOGNIZED canonical district and is
    // NOT in the target list -> excluded (confidently local elsewhere).
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: ['ahmedabad'],
      companySizes: [],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(false);
  });

  // ─── Region (district) fallback rules (boost region-targeting fix) ──────────

  it('(a) canonical viewer district in target list -> match', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: ['surat', 'ahmedabad'],
      companySizes: [],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(true);
  });

  it('(b) canonical viewer district NOT in target list -> excluded', () => {
    const profile: AdProfile = { ...baseProfile, district: 'Rajkot' };
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: ['Surat'],
      companySizes: [],
    };
    // Rajkot is recognized + not targeted -> excluded.
    expect(matchesTargeting(spec, profile)).toBe(false);
  });

  it('(c) empty viewer district + district-targeted -> included (fallback)', () => {
    const profile: AdProfile = { ...baseProfile, district: '' };
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: ['Surat'],
      companySizes: [],
    };
    expect(matchesTargeting(spec, profile)).toBe(true);
  });

  it('(d) unrecognized free-text viewer district + district-targeted -> included (fallback)', () => {
    const profile: AdProfile = { ...baseProfile, district: 'Some Unknown Place' };
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: ['Surat'],
      companySizes: [],
    };
    // Not a recognized canonical district -> unknown-location -> not excluded.
    expect(matchesTargeting(spec, profile)).toBe(true);
  });

  it('(e) no district targeting -> everyone matches (any district value)', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: [],
      companySizes: [],
    };
    expect(matchesTargeting(spec, { ...baseProfile, district: 'Rajkot' })).toBe(true);
    expect(matchesTargeting(spec, { ...baseProfile, district: '' })).toBe(true);
    expect(matchesTargeting(spec, { ...baseProfile, district: 'Some Unknown Place' })).toBe(true);
  });

  describe('isUnknownLocationDistrictMatch (down-rank hook)', () => {
    it('true when district-targeted AND viewer district is blank', () => {
      const spec: TargetingMatchSpec = {
        roles: [],
        sectors: [],
        districts: ['Surat'],
        companySizes: [],
      };
      expect(isUnknownLocationDistrictMatch(spec, { ...baseProfile, district: '' })).toBe(true);
    });

    it('true when district-targeted AND viewer district is unrecognized', () => {
      const spec: TargetingMatchSpec = {
        roles: [],
        sectors: [],
        districts: ['Surat'],
        companySizes: [],
      };
      expect(
        isUnknownLocationDistrictMatch(spec, { ...baseProfile, district: 'Some Unknown Place' }),
      ).toBe(true);
    });

    it('false when district-targeted AND viewer has a recognized district', () => {
      const spec: TargetingMatchSpec = {
        roles: [],
        sectors: [],
        districts: ['Surat'],
        companySizes: [],
      };
      // surat is recognized -> a confident match, not a fallback.
      expect(isUnknownLocationDistrictMatch(spec, baseProfile)).toBe(false);
    });

    it('false when the spec has no district constraint (nothing to down-rank)', () => {
      const spec: TargetingMatchSpec = {
        roles: [],
        sectors: [],
        districts: [],
        companySizes: [],
      };
      expect(isUnknownLocationDistrictMatch(spec, { ...baseProfile, district: '' })).toBe(false);
    });
  });

  it('one mismatch (companySize) -> false', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: [],
      companySizes: ['1-10'],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(false);
  });

  it('all arrays empty -> true', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: [],
      companySizes: [],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(true);
  });

  it('maxConnectionDegree 2: degree 3 -> false', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: [],
      companySizes: [],
      maxConnectionDegree: 2,
    };
    const profile: AdProfile = { ...baseProfile, connectionDegree: 3 };
    expect(matchesTargeting(spec, profile)).toBe(false);
  });

  it('maxConnectionDegree 2: degree 2 -> true', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: [],
      companySizes: [],
      maxConnectionDegree: 2,
    };
    const profile: AdProfile = { ...baseProfile, connectionDegree: 2 };
    expect(matchesTargeting(spec, profile)).toBe(true);
  });

  it('maxConnectionDegree 2: degree 1 -> true', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: [],
      companySizes: [],
      maxConnectionDegree: 2,
    };
    const profile: AdProfile = { ...baseProfile, connectionDegree: 1 };
    expect(matchesTargeting(spec, profile)).toBe(true);
  });

  it('maxConnectionDegree undefined -> true regardless of degree', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: [],
      companySizes: [],
    };
    const profile: AdProfile = { ...baseProfile, connectionDegree: 999 };
    expect(matchesTargeting(spec, profile)).toBe(true);
  });

  it('multi-dim all-match -> true', () => {
    const spec: TargetingMatchSpec = {
      roles: ['manager', 'owner'],
      sectors: ['textile', 'pharma'],
      districts: ['surat', 'ahmedabad'],
      companySizes: ['50-200', '200+'],
      maxConnectionDegree: 3,
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(true);
  });

  it('multi-dim one-mismatch -> false', () => {
    const spec: TargetingMatchSpec = {
      roles: ['manager', 'owner'],
      sectors: ['pharma'],
      districts: ['surat'],
      companySizes: ['50-200'],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(false);
  });

  // Regression: the boost composer ships display-case values ("Weaving",
  // "Surat") while profiles store lowercased data. Before the normalize fix
  // these never matched.
  it('sector match is case-insensitive (display-case spec vs lowercased skill)', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: ['Textile'],
      districts: [],
      companySizes: [],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(true);
  });

  it('district match is case-insensitive', () => {
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: [],
      districts: ['Surat'],
      companySizes: [],
    };
    expect(matchesTargeting(spec, baseProfile)).toBe(true);
  });

  it('sector matches ANY of the member skills, not just the first', () => {
    const profile: AdProfile = { ...baseProfile, skills: ['weaving', 'dyeing'] };
    const spec: TargetingMatchSpec = {
      roles: [],
      sectors: ['Dyeing'],
      districts: [],
      companySizes: [],
    };
    expect(matchesTargeting(spec, profile)).toBe(true);
  });

  // Regression: a slug-based picker value ("east-godavari", "job-work") must
  // match free-text profile data typed with spaces/case ("East Godavari",
  // "Job Work") - so the new pickers work without migrating existing members.
  it('matches across separator/spacing differences (picker slug vs free-text)', () => {
    const profile: AdProfile = {
      ...baseProfile,
      district: 'east godavari',
      skills: ['Job Work'],
    };
    expect(
      matchesTargeting(
        { roles: [], sectors: [], districts: ['east-godavari'], companySizes: [] },
        profile,
      ),
    ).toBe(true);
    expect(
      matchesTargeting(
        { roles: [], sectors: ['job-work'], districts: [], companySizes: [] },
        profile,
      ),
    ).toBe(true);
  });
});
