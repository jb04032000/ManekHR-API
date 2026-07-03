import { allPermissionPaths, type PermissionScope } from './permission-registry';
import type { GrantedPermission } from './permission-matcher';
import type { PathOverride } from './permission-path-overrides';

/** A legacy flat permission grant (mirror of `Role.permissions` entries). */
export interface FlatPermission {
  module: string;
  actions: string[];
  actionScopes?: PermissionScope[];
}

/**
 * Legacy `(module, action)` → registry path(s) mapping. Phase 1a transition
 * only — converts pre-path (custom) roles. Least-privilege: a coarse legacy
 * action maps to the safe subset of leaf paths (sensitive groups — pay /
 * bank / statutory / org — and privileged `appAccess` are excluded). Owners
 * re-tune via the matrix. Team, attendance, leave, holidays, and shifts paths
 * are mapped; other modules stay flat until their own rollout phase.
 */
const TEAM_ACTION_PATHS: Record<string, string[]> = {
  view: [
    'team.directory.view',
    'team.profile.personal.view',
    'team.profile.job.view',
    'team.profile.documents.view',
  ],
  edit: ['team.profile.personal.edit', 'team.profile.job.edit', 'team.profile.documents.edit'],
  create: ['team.member.create'],
  remove: ['team.member.delete'],
  delete: ['team.member.delete'],
};

/**
 * Attendance legacy actions. Least-privilege: `view` confers only the
 * member-facing record read (NOT the org-wide analytics dashboards);
 * `mark` confers self-marking + self-punch; the coarse
 * `manage_regularizations` (which historically also covered approval +
 * settings) confers only the self-service request lifecycle, never the
 * approval or config leaves. The owner re-grants approval / analytics /
 * config via the matrix. The regularization request leaves live under their
 * own `regularization` registry module even though the legacy action sits on
 * `attendance`.
 */
const ATTENDANCE_ACTION_PATHS: Record<string, string[]> = {
  view: ['attendance.record.view'],
  mark: ['attendance.record.mark', 'attendance.selfPunch.create'],
  edit: ['attendance.record.edit'],
  export: ['attendance.export.export'],
  manage_anomalies: ['attendance.anomaly.manage'],
  manage_devices: ['attendance.device.manage'],
  manage_policies: ['attendance.policy.manage'],
  manage_regularizations: [
    'regularization.request.apply',
    'regularization.request.view',
    'regularization.request.cancel',
  ],
};

/**
 * Leave legacy actions. `view` confers safe reads (own requests + balance);
 * `apply_leave` confers the self-service request + comp-off lifecycle;
 * `approve_leave` confers the approval + delegation capability (the
 * service-layer SoD block still prevents deciding one's OWN request, so this
 * cannot be abused even on an odd self-scoped grant); `manage_leave` confers
 * leave-type + settings administration.
 */
const LEAVE_ACTION_PATHS: Record<string, string[]> = {
  view: ['leave.request.view', 'leave.balance.view'],
  apply_leave: ['leave.request.apply', 'leave.request.cancel', 'leave.compOff.apply'],
  approve_leave: ['leave.approval.decide', 'leave.compOff.decide', 'leave.delegation.manage'],
  manage_leave: ['leave.type.manage', 'leave.settings.manage'],
};

/**
 * Holidays legacy actions. The workspace holiday calendar is reference data,
 * not member-owned, so there is no self/all axis; every action maps 1:1 to
 * its single registry leaf. Least-privilege: a coarse legacy action confers
 * only the matching leaf (`view` never confers `create`/`edit`/`delete`). The
 * owner re-tunes via the matrix. `delete` is a hard, irreversible removal and
 * stays owner/admin-only in the seeded presets (the converter only bridges
 * pre-existing custom-role flat grants; it does not widen them).
 */
const HOLIDAYS_ACTION_PATHS: Record<string, string[]> = {
  view: ['holidays.calendar.view'],
  create: ['holidays.calendar.create'],
  edit: ['holidays.calendar.edit'],
  delete: ['holidays.calendar.delete'],
};

/**
 * Shifts legacy actions. The workspace shift catalog is reference data,
 * not member-owned, so there is no self/all axis; every action maps 1:1 to
 * its single registry leaf. Least-privilege: a coarse legacy action confers
 * only the matching leaf (`view` never confers `create`/`edit`/`delete`). The
 * owner re-tunes via the matrix. `delete` is a hard, irreversible removal and
 * stays owner/admin-only in the seeded presets (the converter only bridges
 * pre-existing custom-role flat grants; it does not widen them).
 */
const SHIFTS_ACTION_PATHS: Record<string, string[]> = {
  view: ['shifts.catalog.view'],
  create: ['shifts.catalog.create'],
  edit: ['shifts.catalog.edit'],
  delete: ['shifts.catalog.delete'],
};

const MODULE_ACTION_PATHS: Record<string, Record<string, string[]>> = {
  team: TEAM_ACTION_PATHS,
  attendance: ATTENDANCE_ACTION_PATHS,
  leave: LEAVE_ACTION_PATHS,
  holidays: HOLIDAYS_ACTION_PATHS,
  shifts: SHIFTS_ACTION_PATHS,
};

/**
 * Convert legacy flat grants to hierarchical path grants. Only modules
 * present in the registry are converted; un-mapped modules are skipped
 * (their legacy `permissions` entry stays authoritative until that module's
 * own rollout phase). Order-independent; de-duplicates; when a path is
 * granted at both `self` and `all`, the wider `all` wins.
 */
export function flatGrantsToPaths(permissions: FlatPermission[]): GrantedPermission[] {
  const out = new Map<string, PermissionScope>();
  for (const perm of permissions) {
    const actionMap = MODULE_ACTION_PATHS[perm.module];
    if (!actionMap) continue;
    perm.actions.forEach((action, i) => {
      const paths = actionMap[action];
      if (!paths) return;
      const scope: PermissionScope = perm.actionScopes?.[i] ?? 'self';
      for (const path of paths) {
        if (out.get(path) === 'all') continue;
        out.set(path, scope);
      }
    });
  }
  return [...out.entries()].map(([path, scope]) => ({ path, scope }));
}

const LEGACY_ACTION_ALIASES: Record<string, string> = { remove: 'delete' };

/**
 * Registry leaf paths governed by a legacy `(module, action)` pair — the DENY
 * projection of a per-member override. Derived from the registry (no drift)
 * by grouping leaves on their final action segment; the legacy `remove`
 * action is aliased to the registry's `delete`. Sensitive groups are INCLUDED
 * on purpose: a force-deny must strip every leaf the coarse legacy action
 * covered, or it is silently weakened once routes become path-classified.
 */
function denyPathsFor(module: string, action: string): string[] {
  const segment = LEGACY_ACTION_ALIASES[action] ?? action;
  const prefix = `${module}.`;
  const suffix = `.${segment}`;
  return [...allPermissionPaths()].filter((p) => p.startsWith(prefix) && p.endsWith(suffix));
}

/** A legacy flat per-member override (mirror of `TeamMember.permissionOverrides`). */
export interface FlatPermissionOverride {
  module: string;
  action: string;
  allowed: boolean;
  scope?: PermissionScope;
}

/**
 * Phase 1c migration helper — convert one legacy flat per-member override
 * into path overrides. Non-team overrides → `[]` (untouched by the
 * migration). An allow expands to the non-sensitive paths the coarse action
 * currently grants (preserve effective behaviour — sensitive groups are NOT
 * silently conferred; the owner re-tunes via the new granular matrix). A
 * deny expands to EVERY leaf the action governed (a deny is never weakened).
 */
export function flatTeamOverrideToPathOverrides(override: FlatPermissionOverride): PathOverride[] {
  if (override.module !== 'team') return [];
  if (override.allowed) {
    const paths = MODULE_ACTION_PATHS.team?.[override.action] ?? [];
    return paths.map((path) => ({
      path,
      allowed: true,
      scope: override.scope ?? 'self',
    }));
  }
  return denyPathsFor('team', override.action).map((path) => ({
    path,
    allowed: false,
  }));
}
