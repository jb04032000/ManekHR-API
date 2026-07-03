import { describe, it, expect } from 'vitest';
import { assertViewEditCoherent, normaliseViewEditCoherent } from '../coherence';
import { BadRequestException } from '@nestjs/common';

describe('assertViewEditCoherent', () => {
  it('accepts view-only grants', () =>
    expect(() =>
      assertViewEditCoherent([{ path: 'team.profile.bank.view', scope: 'self' }]),
    ).not.toThrow());

  it('accepts view-all + edit-self', () =>
    expect(() =>
      assertViewEditCoherent([
        { path: 'team.profile.bank.view', scope: 'all' },
        { path: 'team.profile.bank.edit', scope: 'self' },
      ]),
    ).not.toThrow());

  it('accepts view-all + edit-all', () =>
    expect(() =>
      assertViewEditCoherent([
        { path: 'team.profile.bank.view', scope: 'all' },
        { path: 'team.profile.bank.edit', scope: 'all' },
      ]),
    ).not.toThrow());

  it('rejects view-self + edit-all', () => {
    expect(() =>
      assertViewEditCoherent([
        { path: 'team.profile.bank.view', scope: 'self' },
        { path: 'team.profile.bank.edit', scope: 'all' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects edit-only (no view grant)', () => {
    expect(() =>
      assertViewEditCoherent([{ path: 'team.profile.bank.edit', scope: 'all' }]),
    ).toThrow(BadRequestException);
  });

  it('validates per-leaf independently', () => {
    expect(() =>
      assertViewEditCoherent([
        { path: 'team.profile.bank.view', scope: 'all' },
        { path: 'team.profile.bank.edit', scope: 'all' },
        { path: 'team.profile.pay.view', scope: 'self' },
        { path: 'team.profile.pay.edit', scope: 'all' },
      ]),
    ).toThrow(/team\.profile\.pay/);
  });

  it('rejects unknown registry paths', () => {
    expect(() => assertViewEditCoherent([{ path: 'team.bogus.zzz', scope: 'all' }])).toThrow(
      /Unknown permission path/,
    );
  });
});

describe('normaliseViewEditCoherent', () => {
  it('promotes view to satisfy edit', () => {
    const out = normaliseViewEditCoherent([
      { path: 'team.profile.bank.view', scope: 'self' },
      { path: 'team.profile.bank.edit', scope: 'all' },
    ]);
    expect(out.find((g) => g.path === 'team.profile.bank.view')?.scope).toBe('all');
  });

  it('adds missing view grant for an edit', () => {
    const out = normaliseViewEditCoherent([{ path: 'team.profile.bank.edit', scope: 'self' }]);
    expect(out).toContainEqual({ path: 'team.profile.bank.view', scope: 'self' });
  });

  it('is pure (input untouched)', () => {
    const input = [{ path: 'team.profile.bank.edit', scope: 'self' as const }];
    normaliseViewEditCoherent(input);
    expect(input).toEqual([{ path: 'team.profile.bank.edit', scope: 'self' }]);
  });
});
