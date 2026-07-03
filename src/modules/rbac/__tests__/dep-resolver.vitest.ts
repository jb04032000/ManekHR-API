import { describe, it, expect } from 'vitest';
import { assertDepsResolved, resolveImplicitDeps } from '../dep-resolver';
import { BadRequestException } from '@nestjs/common';

describe('assertDepsResolved', () => {
  // Phase 1d follow-up: `team.member.create` now declares per-action
  // `requires` covering every profile-edit path (the create form opens a
  // full-row write). Any test that uses member.create as a grant must
  // satisfy the full chain or use member.delete (which keeps the
  // node-level-only `directory.view@all` requirement).
  it('passes when deps satisfied (member.delete needs only directory.view@all)', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'team.directory.view', scope: 'all' },
        { path: 'team.member.delete', scope: 'all' },
      ]),
    ).not.toThrow());

  it('passes when ALL member.create deps are satisfied (full profile-edit bundle)', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'team.directory.view', scope: 'all' },
        { path: 'team.profile.personal.edit', scope: 'all' },
        { path: 'team.profile.job.edit', scope: 'all' },
        { path: 'team.profile.pay.edit', scope: 'all' },
        { path: 'team.profile.bank.edit', scope: 'all' },
        { path: 'team.profile.statutory.edit', scope: 'all' },
        { path: 'team.profile.org.edit', scope: 'all' },
        { path: 'team.profile.documents.edit', scope: 'all' },
        { path: 'team.member.create', scope: 'all' },
      ]),
    ).not.toThrow());

  it('rejects member.create without one of its profile-edit deps (pay)', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'team.directory.view', scope: 'all' },
        { path: 'team.profile.personal.edit', scope: 'all' },
        { path: 'team.profile.job.edit', scope: 'all' },
        // missing pay.edit
        { path: 'team.profile.bank.edit', scope: 'all' },
        { path: 'team.profile.statutory.edit', scope: 'all' },
        { path: 'team.profile.org.edit', scope: 'all' },
        { path: 'team.profile.documents.edit', scope: 'all' },
        { path: 'team.member.create', scope: 'all' },
      ]),
    ).toThrow(/team\.profile\.pay\.edit/));

  it('rejects when dep missing', () =>
    expect(() => assertDepsResolved([{ path: 'team.member.delete', scope: 'all' }])).toThrow(
      BadRequestException,
    ));

  it('rejects when dep scope insufficient', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'team.directory.view', scope: 'self' },
        { path: 'team.member.delete', scope: 'all' },
      ]),
    ).toThrow(/scope/i));

  it('accepts when ALL of multiple required deps are satisfied (appAccess)', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'team.directory.view', scope: 'all' },
        { path: 'team.profile.org.view', scope: 'all' },
        { path: 'team.appAccess.manage', scope: 'all' },
      ]),
    ).not.toThrow());

  it('rejects when ONE of multiple required deps is missing (appAccess)', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'team.directory.view', scope: 'all' },
        // missing team.profile.org.view@all
        { path: 'team.appAccess.manage', scope: 'all' },
      ]),
    ).toThrow(/team\.profile\.org\.view/));

  it('passes for leaves without requires[]', () =>
    expect(() =>
      assertDepsResolved([{ path: 'team.profile.personal.view', scope: 'self' }]),
    ).not.toThrow());

  it('rejects unknown registry paths', () => {
    expect(() => assertDepsResolved([{ path: 'team.bogus.zzz', scope: 'all' }])).toThrow(
      /Unknown permission path/,
    );
  });

  // Leave self-service grant completeness — granting self-leave must pull the
  // full read bundle so the My Leave / My Comp-off pages load (not blank).
  it('passes when leave.request.view has its leave.balance.view dep', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'leave.request.view', scope: 'self' },
        { path: 'leave.balance.view', scope: 'self' },
      ]),
    ).not.toThrow());

  it('rejects leave.request.view without leave.balance.view', () =>
    expect(() => assertDepsResolved([{ path: 'leave.request.view', scope: 'self' }])).toThrow(
      /leave\.balance\.view/,
    ));

  it('passes when leave.compOff.apply has both read deps', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'leave.compOff.apply', scope: 'self' },
        { path: 'leave.request.view', scope: 'self' },
        { path: 'leave.balance.view', scope: 'self' },
      ]),
    ).not.toThrow());

  it('rejects leave.compOff.apply missing leave.request.view', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'leave.compOff.apply', scope: 'self' },
        { path: 'leave.balance.view', scope: 'self' },
      ]),
    ).toThrow(/leave\.request\.view/));

  it('rejects leave.compOff.apply missing leave.balance.view', () =>
    expect(() =>
      assertDepsResolved([
        { path: 'leave.compOff.apply', scope: 'self' },
        { path: 'leave.request.view', scope: 'self' },
      ]),
    ).toThrow(/leave\.balance\.view/));
});

describe('resolveImplicitDeps', () => {
  it('adds missing dep grants at required scope', () => {
    const out = resolveImplicitDeps([{ path: 'team.member.create', scope: 'all' }]);
    expect(out).toContainEqual({ path: 'team.directory.view', scope: 'all' });
  });

  it('upgrades insufficient-scope deps', () => {
    const out = resolveImplicitDeps([
      { path: 'team.directory.view', scope: 'self' },
      { path: 'team.member.delete', scope: 'all' },
    ]);
    expect(out.find((g) => g.path === 'team.directory.view')?.scope).toBe('all');
  });

  it('is pure (input untouched)', () => {
    const input = [{ path: 'team.member.create', scope: 'all' as const }];
    resolveImplicitDeps(input);
    expect(input).toEqual([{ path: 'team.member.create', scope: 'all' }]);
  });

  it('adds the leave.balance.view dep for leave.request.view', () => {
    const out = resolveImplicitDeps([{ path: 'leave.request.view', scope: 'self' }]);
    expect(out).toContainEqual({ path: 'leave.balance.view', scope: 'self' });
  });

  it('adds both read deps for leave.compOff.apply (single pass)', () => {
    const out = resolveImplicitDeps([{ path: 'leave.compOff.apply', scope: 'self' }]);
    expect(out).toContainEqual({ path: 'leave.request.view', scope: 'self' });
    expect(out).toContainEqual({ path: 'leave.balance.view', scope: 'self' });
  });
});
