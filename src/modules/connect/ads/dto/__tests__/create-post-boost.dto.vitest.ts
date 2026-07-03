import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreatePostBoostDto } from '../create-post-boost.dto';

/**
 * Unit tests for `CreatePostBoostDto` validation (TDD - RED first). Mirrors the
 * listing-boost DTO but keys off `postId` and allows the post objectives
 * `reach` / `profile_visits` (a post HAS an author profile, so `profile_visits`
 * is valid here; the listing-only `inquiries` is not).
 */
describe('CreatePostBoostDto', () => {
  function validate(plain: object) {
    return validateSync(plainToInstance(CreatePostBoostDto, plain), { whitelist: true });
  }

  it('accepts a fully valid payload', () => {
    expect(
      validate({ postId: 'abc123', objective: 'reach', totalBudget: 99, days: 7 }),
    ).toHaveLength(0);
  });

  // The business minimum (default 99) + allowed-duration set now live in the
  // admin-tunable pricing config, enforced in BoostService. The DTO keeps only a
  // wide guardrail (budget >= 1, days 1-365) so an admin can change them with no
  // deploy.
  it('accepts totalBudget = 98 at the DTO layer (real min moved to live config / service)', () => {
    const errors = validate({ postId: 'abc123', objective: 'reach', totalBudget: 98, days: 7 });
    expect(errors.find((e) => e.property === 'totalBudget')).toBeUndefined();
  });

  it('rejects totalBudget = 0 (below the DTO guardrail floor)', () => {
    const errors = validate({ postId: 'abc123', objective: 'reach', totalBudget: 0, days: 7 });
    expect(errors.find((e) => e.property === 'totalBudget')).toBeDefined();
  });

  it('accepts days = 5 at the DTO layer (allowed set moved to live config / service)', () => {
    const errors = validate({ postId: 'abc123', objective: 'reach', totalBudget: 200, days: 5 });
    expect(errors.find((e) => e.property === 'days')).toBeUndefined();
  });

  it('rejects days outside the DTO guardrail range (0 and 366)', () => {
    for (const days of [0, 366]) {
      const errors = validate({ postId: 'abc123', objective: 'reach', totalBudget: 200, days });
      expect(
        errors.find((e) => e.property === 'days'),
        `days=${days} should fail`,
      ).toBeDefined();
    }
  });

  it('accepts both valid objective values (reach, profile_visits)', () => {
    for (const objective of ['reach', 'profile_visits']) {
      const errors = validate({ postId: 'abc123', objective, totalBudget: 200, days: 7 });
      expect(errors, `objective=${objective} should pass`).toHaveLength(0);
    }
  });

  it('rejects objective = "inquiries" (listing-only; not valid for a post)', () => {
    const errors = validate({
      postId: 'abc123',
      objective: 'inquiries',
      totalBudget: 200,
      days: 7,
    });
    expect(errors.find((e) => e.property === 'objective')).toBeDefined();
  });

  it('rejects missing postId', () => {
    const errors = validate({ objective: 'reach', totalBudget: 200, days: 7 });
    expect(errors.find((e) => e.property === 'postId')).toBeDefined();
  });

  it('rejects empty string postId', () => {
    const errors = validate({ postId: '', objective: 'reach', totalBudget: 200, days: 7 });
    expect(errors.find((e) => e.property === 'postId')).toBeDefined();
  });

  it('accepts omitted targeting (absent = broadest reach)', () => {
    expect(
      validate({ postId: 'abc123', objective: 'reach', totalBudget: 200, days: 7 }),
    ).toHaveLength(0);
  });

  it('drills into nested targeting and catches maxConnectionDegree = 4', () => {
    const errors = validate({
      postId: 'abc123',
      objective: 'reach',
      totalBudget: 200,
      days: 7,
      targeting: { maxConnectionDegree: 4 },
    });
    expect(errors.find((e) => e.property === 'targeting')).toBeDefined();
  });
});
