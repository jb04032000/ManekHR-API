import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateListingBoostDto } from '../create-listing-boost.dto';

/**
 * Unit tests for `CreateListingBoostDto` validation constraints (TDD - RED first).
 * A listing boost mirrors the post-boost DTO but keys off `listingId` and
 * restricts objectives to `reach` / `inquiries` (a listing has no profile, so
 * `profile_visits` is not a valid objective here).
 */
describe('CreateListingBoostDto', () => {
  function validate(plain: object) {
    return validateSync(plainToInstance(CreateListingBoostDto, plain), {
      whitelist: true,
    });
  }

  it('accepts a fully valid payload', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'reach',
      totalBudget: 99,
      days: 7,
    });
    expect(errors).toHaveLength(0);
  });

  // The business minimum (default 99) + allowed-duration set are now enforced in
  // BoostService against the live, admin-tunable pricing config, NOT in the DTO.
  // The DTO keeps only a wide guardrail (budget >= 1, days 1-365) so an admin can
  // lower/raise the real min or change durations with no deploy.
  it('accepts totalBudget = 98 at the DTO layer (real min moved to live config / service)', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'reach',
      totalBudget: 98,
      days: 7,
    });
    expect(errors.find((e) => e.property === 'totalBudget')).toBeUndefined();
  });

  it('rejects totalBudget = 0 (below the DTO guardrail floor)', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'reach',
      totalBudget: 0,
      days: 7,
    });
    expect(errors.find((e) => e.property === 'totalBudget')).toBeDefined();
  });

  it('accepts days = 5 at the DTO layer (allowed set moved to live config / service)', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'reach',
      totalBudget: 200,
      days: 5,
    });
    expect(errors.find((e) => e.property === 'days')).toBeUndefined();
  });

  it('rejects days outside the DTO guardrail range (0 and 366)', () => {
    for (const days of [0, 366]) {
      const errors = validate({
        listingId: 'abc123',
        objective: 'reach',
        totalBudget: 200,
        days,
      });
      expect(
        errors.find((e) => e.property === 'days'),
        `days=${days} should fail`,
      ).toBeDefined();
    }
  });

  it('accepts the default durations [3, 7, 14, 30] at the DTO layer', () => {
    for (const days of [3, 7, 14, 30]) {
      const errors = validate({
        listingId: 'abc123',
        objective: 'reach',
        totalBudget: 200,
        days,
      });
      expect(errors, `days=${days} should pass`).toHaveLength(0);
    }
  });

  it('accepts both valid objective values (reach, inquiries)', () => {
    for (const objective of ['reach', 'inquiries']) {
      const errors = validate({
        listingId: 'abc123',
        objective,
        totalBudget: 200,
        days: 7,
      });
      expect(errors, `objective=${objective} should pass`).toHaveLength(0);
    }
  });

  it('rejects objective = "profile_visits" (post-only; not valid for a listing)', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'profile_visits',
      totalBudget: 200,
      days: 7,
    });
    expect(errors.find((e) => e.property === 'objective')).toBeDefined();
  });

  it('rejects objective = "bogus"', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'bogus',
      totalBudget: 200,
      days: 7,
    });
    expect(errors.find((e) => e.property === 'objective')).toBeDefined();
  });

  it('rejects missing listingId', () => {
    const errors = validate({
      objective: 'reach',
      totalBudget: 200,
      days: 7,
    });
    expect(errors.find((e) => e.property === 'listingId')).toBeDefined();
  });

  it('rejects empty string listingId', () => {
    const errors = validate({
      listingId: '',
      objective: 'reach',
      totalBudget: 200,
      days: 7,
    });
    expect(errors.find((e) => e.property === 'listingId')).toBeDefined();
  });

  it('accepts omitted targeting (absent = broadest reach)', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'reach',
      totalBudget: 200,
      days: 7,
    });
    expect(errors).toHaveLength(0);
  });

  it('drills into nested targeting and catches maxConnectionDegree = 4', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'reach',
      totalBudget: 200,
      days: 7,
      targeting: { maxConnectionDegree: 4 },
    });
    expect(errors.find((e) => e.property === 'targeting')).toBeDefined();
  });

  it('accepts targeting with empty arrays (broadest reach)', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'reach',
      totalBudget: 200,
      days: 7,
      targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects targeting array with more than 20 items', () => {
    const errors = validate({
      listingId: 'abc123',
      objective: 'reach',
      totalBudget: 200,
      days: 7,
      targeting: { roles: Array.from({ length: 21 }, (_, i) => `role${i}`) },
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
