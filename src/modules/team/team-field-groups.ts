/**
 * Team profile field-group classification (RBAC re-architecture — design §6/§7).
 *
 * The omnibus `POST /team` (create) and `PATCH /team/:memberId` (update)
 * endpoints accept a single wide DTO spanning every profile field. The route
 * guard can only check ONE permission path for the whole request, so without
 * a service-layer split a caller holding `team.profile.personal.edit` could
 * write another member's bank account, salary or statutory IDs through the
 * same endpoint.
 *
 * This module classifies every `CreateTeamMemberDto` / `UpdateTeamMemberDto`
 * key into a registry field-group. `team.service` then requires the caller to
 * hold each present group's `.edit` path (see `assertTeamFieldGroupGrants`).
 *
 * Fail-closed: a DTO key absent from `TEAM_FIELD_GROUP` is reported as an
 * unknown key — the service rejects it as owner-only. Any field added to the
 * DTO MUST be classified here or it becomes un-writable by non-owners.
 */

/** A registry field-group under `team.profile.*`. Mirrors `PERMISSION_REGISTRY`. */
export type TeamFieldGroup = 'personal' | 'job' | 'pay' | 'bank' | 'statutory' | 'org';

/**
 * HR-sensitive groups — `sensitive: true` in the permission registry. On
 * member CREATE these each require their own `.edit` grant; the non-sensitive
 * groups (personal, job) are covered by the coarse `team.member.create` grant.
 */
export const SENSITIVE_TEAM_FIELD_GROUPS: ReadonlySet<TeamFieldGroup> = new Set<TeamFieldGroup>([
  'pay',
  'bank',
  'statutory',
  'org',
]);

/**
 * Every `CreateTeamMemberDto` / `UpdateTeamMemberDto` key → its field-group.
 * Exhaustive against `team.dto.ts`; a key missing here fails closed.
 */
export const TEAM_FIELD_GROUP: Readonly<Record<string, TeamFieldGroup>> = {
  // personal & contact — superset of the self-edit allowlist (`team.service`).
  name: 'personal',
  mobile: 'personal',
  email: 'personal',
  avatar: 'personal',
  gender: 'personal',
  dateOfBirth: 'personal',
  bloodGroup: 'personal',
  address: 'personal',
  emergencyContactName: 'personal',
  emergencyContactNumber: 'personal',
  maritalStatus: 'personal',
  fatherOrSpouseName: 'personal',
  nationality: 'personal',

  // job, schedule & lifecycle
  designation: 'job',
  department: 'job',
  location: 'job',
  shiftId: 'job',
  scheduleType: 'job',
  weeklyOff: 'job',
  customSchedule: 'job',
  dailyHours: 'job',
  workingDays: 'job',
  employmentType: 'job',
  employeeCode: 'job',
  dateOfJoining: 'job',
  dateOfResignation: 'job',
  isActive: 'job',

  // compensation (sensitive)
  salaryType: 'pay',
  salaryAmount: 'pay',
  finalMonthlyOverride: 'pay',
  salaryDayBasis: 'pay',
  fixedMonthDays: 'pay',
  attendancePayMode: 'pay',
  ctcAmount: 'pay',
  isKarigar: 'pay',
  karigarSkillType: 'pay',
  karigarDailyRatePaise: 'pay',
  componentTemplateId: 'pay',
  componentOverrides: 'pay',

  // bank & payment routing (sensitive)
  bankDetails: 'bank',
  upiDetails: 'bank',
  preferredMethod: 'bank',

  // statutory & tax IDs (sensitive)
  pan: 'statutory',
  uan: 'statutory',
  aadhaar: 'statutory',
  aadhaarImageUrl: 'statutory',
  taxRegime: 'statutory',
  stateOfEmployment: 'statutory',
  pfApplicable: 'statutory',
  pfOptedOut: 'statutory',
  esiApplicable: 'statutory',
  esiIpNumber: 'statutory',
  isNonItrFiler: 'statutory',
  // Phase 1 compliance: per-member minimum-wage override (HR/Owner only, same gate as pan/uan).
  minimumWageMonthlyOverride: 'statutory',

  // org placement — reporting line & role assignment (sensitive)
  rbacRoleId: 'org',
  reportsTo: 'org',
};

/** Human-readable group label for the 403 message shown to a blocked caller. */
export const TEAM_FIELD_GROUP_LABEL: Readonly<Record<TeamFieldGroup, string>> = {
  personal: 'personal & contact details',
  job: 'job & schedule details',
  pay: 'compensation details',
  bank: 'bank & payment details',
  statutory: 'statutory & tax details',
  org: 'reporting line & role assignment',
};

/** The registry `.edit` path that gates writes to `group`. */
export function teamFieldGroupEditPath(group: TeamFieldGroup): string {
  return `team.profile.${group}.edit`;
}

export interface TeamFieldClassification {
  /** Distinct field-groups touched by the inspected DTO keys. */
  groups: Set<TeamFieldGroup>;
  /** Keys not present in `TEAM_FIELD_GROUP` — rejected as owner-only. */
  unknownKeys: string[];
}

/**
 * Partition a set of DTO keys into their field-groups. Pure — no DI, no I/O —
 * so the classification table can be unit-tested directly.
 */
export function classifyTeamFields(keys: Iterable<string>): TeamFieldClassification {
  const groups = new Set<TeamFieldGroup>();
  const unknownKeys: string[] = [];
  for (const key of keys) {
    const group = TEAM_FIELD_GROUP[key];
    if (group) groups.add(group);
    else unknownKeys.push(key);
  }
  return { groups, unknownKeys };
}
