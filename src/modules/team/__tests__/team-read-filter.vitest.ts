import { describe, it, expect } from 'vitest';
import { filterTeamMemberRead } from '../team-read-filter';
import type { PermissionScope } from '../../rbac/permission-registry';

/**
 * 2026-05-22 security fix — read-side field-group view gate. A directory-viewer
 * lacking a group's `*.view` grant must not receive that group's fields.
 */

const fullResp = {
  // directory identity (always visible under directory.view)
  id: 'm1',
  name: 'Asha Patel',
  mobile: '9999900000',
  email: 'asha@example.com',
  designation: 'Karigar',
  department: 'Weaving',
  location: 'Surat',
  avatar: null,
  // personal detail
  dateOfBirth: '1990-01-01',
  bloodGroup: 'O+',
  address: 'Ring Road',
  gender: 'female',
  // job detail
  employeeCode: 'E-001',
  dateOfJoining: '2020-01-01',
  // pay (sensitive)
  salaryType: 'monthly',
  salaryAmount: 25000,
  // bank (sensitive)
  bankDetails: { accountNumber: '1234567890' },
  upiDetails: null,
  preferredMethod: 'bank',
  // statutory (sensitive)
  pan: 'ABCDE1234F',
  uan: '100200300',
  aadhaar: '1111-2222-3333',
  aadhaarImageUrl: 'https://x/y.jpg',
  // org
  reportsTo: 'm2',
  // access config
  permissionOverrides: [{ module: 'team' }],
  permissionPathOverrides: [{ path: 'team.directory.view' }],
} as Record<string, unknown>;

function makeHasPath(grants: Record<string, PermissionScope>) {
  return (path: string, scope: PermissionScope): boolean => {
    const granted = grants[path];
    if (!granted) return false;
    if (scope === 'self') return granted === 'self' || granted === 'all';
    return granted === 'all';
  };
}

describe('filterTeamMemberRead', () => {
  it('owner sees every field unchanged', () => {
    const out = filterTeamMemberRead(fullResp, {
      isOwner: true,
      isOwnRecord: false,
      hasPath: () => false,
    });
    expect(out).toEqual(fullResp);
  });

  it('directory-only viewer (other record) gets identity but NOT sensitive groups', () => {
    const out = filterTeamMemberRead(fullResp, {
      isOwner: false,
      isOwnRecord: false,
      hasPath: makeHasPath({ 'team.directory.view': 'all' }),
    });
    // identity kept
    expect(out.name).toBe('Asha Patel');
    expect(out.mobile).toBe('9999900000');
    expect(out.designation).toBe('Karigar');
    // sensitive + detail stripped (the leak that prompted this fix)
    expect(out).not.toHaveProperty('salaryAmount');
    expect(out).not.toHaveProperty('bankDetails');
    expect(out).not.toHaveProperty('pan');
    expect(out).not.toHaveProperty('aadhaar');
    expect(out).not.toHaveProperty('aadhaarImageUrl');
    expect(out).not.toHaveProperty('dateOfBirth');
    expect(out).not.toHaveProperty('reportsTo');
    expect(out).not.toHaveProperty('employeeCode');
    // access config stripped without appAccess.manage
    expect(out).not.toHaveProperty('permissionOverrides');
    expect(out).not.toHaveProperty('permissionPathOverrides');
  });

  it('pay.view@all keeps compensation but still hides bank + statutory', () => {
    const out = filterTeamMemberRead(fullResp, {
      isOwner: false,
      isOwnRecord: false,
      hasPath: makeHasPath({ 'team.directory.view': 'all', 'team.profile.pay.view': 'all' }),
    });
    expect(out.salaryAmount).toBe(25000);
    expect(out.salaryType).toBe('monthly');
    expect(out).not.toHaveProperty('bankDetails');
    expect(out).not.toHaveProperty('pan');
  });

  it('own record + personal.view@self keeps personal, still hides pay', () => {
    const out = filterTeamMemberRead(fullResp, {
      isOwner: false,
      isOwnRecord: true,
      hasPath: makeHasPath({ 'team.profile.personal.view': 'self' }),
    });
    expect(out.dateOfBirth).toBe('1990-01-01');
    expect(out.gender).toBe('female');
    expect(out).not.toHaveProperty('salaryAmount');
    expect(out).not.toHaveProperty('bankDetails');
  });

  it('self-scoped group grant does NOT satisfy a cross-member (all) read', () => {
    const out = filterTeamMemberRead(fullResp, {
      isOwner: false,
      isOwnRecord: false, // other member -> requires 'all'
      hasPath: makeHasPath({ 'team.directory.view': 'all', 'team.profile.bank.view': 'self' }),
    });
    expect(out).not.toHaveProperty('bankDetails');
  });

  it('appAccess.manage holder keeps the override config', () => {
    const out = filterTeamMemberRead(fullResp, {
      isOwner: false,
      isOwnRecord: false,
      hasPath: makeHasPath({ 'team.directory.view': 'all', 'team.appAccess.manage': 'all' }),
    });
    expect(out.permissionOverrides).toEqual([{ module: 'team' }]);
    expect(out.permissionPathOverrides).toEqual([{ path: 'team.directory.view' }]);
  });

  it('does not mutate the input object', () => {
    const snapshot = JSON.parse(JSON.stringify(fullResp));
    filterTeamMemberRead(fullResp, {
      isOwner: false,
      isOwnRecord: false,
      hasPath: makeHasPath({ 'team.directory.view': 'all' }),
    });
    expect(fullResp).toEqual(snapshot);
  });
});
