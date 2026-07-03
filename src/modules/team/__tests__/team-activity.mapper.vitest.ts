import { describe, it, expect } from 'vitest';
import { toTeamActivityDto, safeTeamActivityMeta } from '../team-activity.mapper';

/**
 * 2026-05-22 — the team activity feed must NEVER leak sensitive values
 * (salary amounts, bank/statutory IDs). It surfaces only who/what/whom/when
 * plus coarse field-GROUP labels. These tests lock that guarantee.
 */

const baseEvent = {
  _id: 'evt1',
  module: 'team',
  action: 'team.member_updated',
  actorId: 'actor1',
  actorNameSnapshot: 'Priya Manager',
  entityType: 'team_member',
  entityId: 'mem1',
  createdAt: new Date('2026-05-22T10:00:00Z'),
  // Sensitive payloads the mapper MUST drop:
  before: { salaryAmount: 50000, bankDetails: { accountNumber: '111' } },
  after: { salaryAmount: 60000, bankDetails: { accountNumber: '222' } },
  meta: { fieldsChanged: ['salaryAmount', 'bankDetails', 'name'] },
} as any;

describe('toTeamActivityDto — redaction', () => {
  it('never emits before/after or any sensitive value', () => {
    const dto = toTeamActivityDto(baseEvent, 'Asha Patel');
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('salaryAmount');
    expect(serialized).not.toContain('bankDetails');
    expect(serialized).not.toContain('50000');
    expect(serialized).not.toContain('60000');
    expect(serialized).not.toContain('111');
    expect(dto).not.toHaveProperty('before');
    expect(dto).not.toHaveProperty('after');
  });

  it('member_updated surfaces coarse field-GROUP labels, not field names/values', () => {
    const dto = toTeamActivityDto(baseEvent, 'Asha Patel');
    // salaryAmount->pay, bankDetails->bank, name->personal
    expect(dto.meta).toEqual({ groups: ['pay', 'bank', 'personal'] });
  });

  it('carries actor, action, target, timestamp', () => {
    const dto = toTeamActivityDto(baseEvent, 'Asha Patel');
    expect(dto.actor).toEqual({ id: 'actor1', name: 'Priya Manager' });
    expect(dto.action).toBe('team.member_updated');
    expect(dto.target).toEqual({ id: 'mem1', name: 'Asha Patel', type: 'team_member' });
    expect(dto.at).toBe('2026-05-22T10:00:00.000Z');
  });

  it('falls back to "Removed member" when target name is unresolved', () => {
    const dto = toTeamActivityDto(baseEvent, undefined);
    expect(dto.target?.name).toBe('Removed member');
  });

  it('falls back to "Unknown user" when actor snapshot is missing', () => {
    const dto = toTeamActivityDto({ ...baseEvent, actorNameSnapshot: undefined }, 'Asha');
    expect(dto.actor.name).toBe('Unknown user');
  });
});

describe('safeTeamActivityMeta — fail-closed allowlist', () => {
  it('member_created keeps only salaryType category, drops employeeCode etc', () => {
    const out = safeTeamActivityMeta('team.member_created', {
      salaryType: 'monthly',
      employeeCode: 'E-001',
      isKarigar: true,
    });
    expect(out).toEqual({ salaryType: 'monthly' });
  });

  it('access_granted keeps only sendMethod', () => {
    const out = safeTeamActivityMeta('team.access_granted', {
      sendMethod: 'sms',
      rbacRoleId: 'role123',
      emailProvided: true,
    });
    expect(out).toEqual({ sendMethod: 'sms' });
  });

  it('unknown action drops all meta (fail-closed)', () => {
    const out = safeTeamActivityMeta('team.member_archived', { secret: 'x', amount: 9999 });
    expect(out).toEqual({});
  });

  it('handles missing meta', () => {
    expect(safeTeamActivityMeta('team.member_updated', undefined)).toEqual({});
  });
});
