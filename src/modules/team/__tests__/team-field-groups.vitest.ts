import { describe, it, expect } from 'vitest';
import {
  classifyTeamFields,
  TEAM_FIELD_GROUP,
  TEAM_FIELD_GROUP_LABEL,
  SENSITIVE_TEAM_FIELD_GROUPS,
  teamFieldGroupEditPath,
  type TeamFieldGroup,
} from '../team-field-groups';
import { isValidPermissionPath } from '../../rbac/permission-registry';

/**
 * Pure-function coverage for the team profile field-group classifier
 * (RBAC re-architecture §6/§7). This table is the trust boundary for the
 * omnibus create/update endpoints — a misclassified field would let a
 * caller reach a sensitive group it was never granted, so it is unit-tested
 * directly rather than only through the service.
 */
describe('team-field-groups — classifyTeamFields', () => {
  it('classifies a bank-only payload to the bank group', () => {
    const { groups, unknownKeys } = classifyTeamFields(['bankDetails', 'upiDetails']);
    expect([...groups]).toEqual(['bank']);
    expect(unknownKeys).toEqual([]);
  });

  it('classifies a mixed payload into every touched group', () => {
    const { groups } = classifyTeamFields(['name', 'salaryAmount', 'pan']);
    expect([...groups].sort()).toEqual(['pay', 'personal', 'statutory']);
  });

  it('reports unclassified keys instead of silently allowing them (fail-closed)', () => {
    const { groups, unknownKeys } = classifyTeamFields(['name', 'madeUpField']);
    expect([...groups]).toEqual(['personal']);
    expect(unknownKeys).toEqual(['madeUpField']);
  });

  it('returns empty groups for an empty payload', () => {
    const { groups, unknownKeys } = classifyTeamFields([]);
    expect(groups.size).toBe(0);
    expect(unknownKeys).toEqual([]);
  });

  it('classifies every CreateTeamMemberDto / UpdateTeamMemberDto key', () => {
    // Drift guard — mirrors team.dto.ts. A new DTO field added without a
    // TEAM_FIELD_GROUP entry must fail this test (and would fail closed at
    // runtime — rejected as owner-only by assertTeamFieldGroupGrants).
    const dtoKeys = [
      'name',
      'mobile',
      'email',
      'designation',
      'department',
      'location',
      'avatar',
      'rbacRoleId',
      'shiftId',
      'reportsTo',
      'scheduleType',
      'weeklyOff',
      'customSchedule',
      'salaryType',
      'salaryAmount',
      'dailyHours',
      'workingDays',
      'finalMonthlyOverride',
      'salaryDayBasis',
      'fixedMonthDays',
      'attendancePayMode',
      'ctcAmount',
      'pan',
      'uan',
      'taxRegime',
      'stateOfEmployment',
      'employmentType',
      'pfApplicable',
      'pfOptedOut',
      'esiApplicable',
      'esiIpNumber',
      'maritalStatus',
      'isNonItrFiler',
      'isKarigar',
      'karigarSkillType',
      'karigarDailyRatePaise',
      'componentTemplateId',
      'componentOverrides',
      'bankDetails',
      'upiDetails',
      'preferredMethod',
      'aadhaar',
      'aadhaarImageUrl',
      'fatherOrSpouseName',
      'nationality',
      'employeeCode',
      'dateOfBirth',
      'dateOfJoining',
      'dateOfResignation',
      'gender',
      'bloodGroup',
      'emergencyContactName',
      'emergencyContactNumber',
      'address',
      'isActive',
    ];
    const { unknownKeys } = classifyTeamFields(dtoKeys);
    expect(unknownKeys).toEqual([]);
  });
});

describe('team-field-groups — registry alignment', () => {
  it('marks pay / bank / statutory / org sensitive, personal / job not', () => {
    expect([...SENSITIVE_TEAM_FIELD_GROUPS].sort()).toEqual(['bank', 'org', 'pay', 'statutory']);
    expect(SENSITIVE_TEAM_FIELD_GROUPS.has('personal')).toBe(false);
    expect(SENSITIVE_TEAM_FIELD_GROUPS.has('job')).toBe(false);
  });

  it('derives the registry edit-path for a group', () => {
    expect(teamFieldGroupEditPath('bank')).toBe('team.profile.bank.edit');
    expect(teamFieldGroupEditPath('statutory')).toBe('team.profile.statutory.edit');
  });

  it('every classified group resolves to a real registry leaf path', () => {
    const groups = new Set<TeamFieldGroup>(Object.values(TEAM_FIELD_GROUP));
    for (const group of groups) {
      expect(isValidPermissionPath(teamFieldGroupEditPath(group))).toBe(true);
    }
  });

  it('every classified group has a human-readable label', () => {
    for (const group of new Set<TeamFieldGroup>(Object.values(TEAM_FIELD_GROUP))) {
      expect(TEAM_FIELD_GROUP_LABEL[group]).toBeTruthy();
    }
  });
});
