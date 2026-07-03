import type { TeamFieldGroup } from './team-field-groups';
import type { PermissionScope } from '../rbac/permission-registry';

/**
 * Read-side field-group view gate (2026-05-22 security fix).
 *
 * `toResponse` returns every profile field. The read endpoints' route guard
 * only checks `team.directory.view` (can you see this person at all), NOT the
 * per-field-group `*.view` grants. So a directory-viewer lacking
 * `team.profile.bank.view` / `pay.view` / `statutory.view` would still receive
 * bank details, salary, PAN and Aadhaar in the payload (the web client merely
 * hides the tabs; the data is in the response). This strips every field-group
 * the caller cannot view, the read-side mirror of the write-side
 * `assertTeamFieldGroupGrants`.
 *
 * Directory-identity fields (id, name, mobile, email, designation, department,
 * location, avatar, role badge, app-access status, lifecycle dates) are
 * governed by `team.directory.view` itself and always kept: they drive the
 * directory list/card the caller is already permitted to see. Any toResponse
 * key NOT listed in `TEAM_READ_FIELD_GROUP` is treated as directory-identity
 * and left visible.
 */

/** Detail field (toResponse key) to the field-group whose `.view` gates it. */
const TEAM_READ_FIELD_GROUP: Readonly<Record<string, TeamFieldGroup>> = {
  // personal DETAIL (identity name/mobile/email/avatar stay via directory.view)
  dateOfBirth: 'personal',
  bloodGroup: 'personal',
  maritalStatus: 'personal',
  fatherOrSpouseName: 'personal',
  address: 'personal',
  emergencyContactName: 'personal',
  emergencyContactNumber: 'personal',
  gender: 'personal',

  // job DETAIL (designation/department/location stay via directory.view)
  shift: 'job',
  scheduleType: 'job',
  weeklyOff: 'job',
  customSchedule: 'job',
  dailyHours: 'job',
  workingDays: 'job',
  employmentType: 'job',
  employeeCode: 'job',
  dateOfJoining: 'job',
  dateOfResignation: 'job',

  // compensation (sensitive)
  salaryType: 'pay',
  salaryAmount: 'pay',
  finalMonthlyOverride: 'pay',
  ctcAmount: 'pay',
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

  // org placement (sensitive)
  reportsTo: 'org',
};

/**
 * Raw per-member override config is access-management data, not profile data.
 * Only `team.appAccess.manage` holders (and owners) may read it; otherwise a
 * directory-viewer could enumerate another member's exact permission set.
 */
const ACCESS_CONFIG_FIELDS = ['permissionOverrides', 'permissionPathOverrides'] as const;

/**
 * Strip field-groups the caller may not view from a `toResponse` payload.
 * Pure: takes a `hasPath` predicate (the caller's effective path-grant check)
 * so it can be unit-tested without DI.
 *
 *  - `isOwner` true short-circuits (owners see everything).
 *  - own record  -> a `self`-scoped view grant suffices.
 *  - other record -> an `all`-scoped view grant is required.
 */
export function filterTeamMemberRead<T extends Record<string, unknown>>(
  resp: T,
  opts: {
    isOwner: boolean;
    isOwnRecord: boolean;
    hasPath: (path: string, scope: PermissionScope) => boolean;
  },
): T {
  if (opts.isOwner) return resp;
  const scope: PermissionScope = opts.isOwnRecord ? 'self' : 'all';
  const out: Record<string, unknown> = { ...resp };

  for (const [field, group] of Object.entries(TEAM_READ_FIELD_GROUP)) {
    if (!(field in out)) continue;
    if (!opts.hasPath(`team.profile.${group}.view`, scope)) {
      delete out[field];
    }
  }

  if (!opts.hasPath('team.appAccess.manage', 'all')) {
    for (const f of ACCESS_CONFIG_FIELDS) delete out[f];
  }

  return out as T;
}
