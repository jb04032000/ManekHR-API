import type { GrantedPermission } from './permission-matcher';

export interface RolePreset {
  /** Stable identifier — referenced by FE preset selector. */
  key: string;
  /** i18n label key for the preset selector. */
  labelKey: string;
  /** i18n description key (must end in `.desc`). */
  descriptionKey: string;
  /** Canonical grant list. Coherent + deps-resolved by construction. */
  paths: GrantedPermission[];
}

const PROFILE_GROUPS = ['personal', 'job', 'pay', 'bank', 'statutory', 'org', 'documents'] as const;

function allView(scope: 'self' | 'all'): GrantedPermission[] {
  return PROFILE_GROUPS.map((g) => ({ path: `team.profile.${g}.view`, scope }));
}
function allEdit(scope: 'self' | 'all'): GrantedPermission[] {
  return PROFILE_GROUPS.map((g) => ({ path: `team.profile.${g}.edit`, scope }));
}

/**
 * Industry-derived Team-module role presets. Mirrors HR-platform standards
 * (Bamboo / Keka / Rippling / Deel) — see
 * `~/.claude/plans/rbac-phase-1d-design-20-05-2026.md` §1 for the research
 * synthesis. Presets are NOT seeded roles; they're one-click fills for
 * custom role authoring + per-member overrides matrix.
 *
 * **Scope convention.** `GrantedPermission` always carries a `scope`. For
 * actions declared `scoped: false` in the registry (`member.create`,
 * `member.delete`, `appAccess.manage`), `scope: 'all'` is the conventional
 * sentinel — `RolesGuard` and `pathGrantSatisfies` ignore the scope on
 * unscoped actions. Mirrors the `paths()` helper in `role-seeder.constants.ts`
 * (every seeded role follows the same convention).
 */
export const TEAM_ROLE_PRESETS: RolePreset[] = [
  {
    key: 'hrAdmin',
    labelKey: 'rbac.preset.hrAdmin',
    descriptionKey: 'rbac.presetDesc.hrAdmin',
    paths: [
      { path: 'team.directory.view', scope: 'all' },
      { path: 'team.member.create', scope: 'all' },
      { path: 'team.member.delete', scope: 'all' },
      { path: 'team.appAccess.manage', scope: 'all' },
      ...allView('all'),
      ...allEdit('all'),
    ],
  },
  {
    key: 'hrMember',
    labelKey: 'rbac.preset.hrMember',
    descriptionKey: 'rbac.presetDesc.hrMember',
    paths: [
      { path: 'team.directory.view', scope: 'all' },
      ...allView('all'),
      // hrMember edits personal / job / documents on anyone; pay / bank /
      // statutory / org are view-only (industry SoD separation — HR Member
      // is below Payroll Admin tier per Keka taxonomy). Member CREATE is
      // owned by `hrAdmin` — the create action bundles every profile-edit
      // grant (it opens a full-form), which would exceed this preset's
      // intent. A junior HR who needs to add members gets `hrAdmin` or a
      // custom role.
      { path: 'team.profile.personal.edit', scope: 'all' },
      { path: 'team.profile.job.edit', scope: 'all' },
      { path: 'team.profile.documents.edit', scope: 'all' },
    ],
  },
  {
    key: 'manager',
    labelKey: 'rbac.preset.manager',
    descriptionKey: 'rbac.presetDesc.manager',
    paths: [
      { path: 'team.directory.view', scope: 'all' },
      // Managers don't add headcount — HR does. The `member.create` action
      // requires every profile-edit path; granting it to a line manager
      // would imply edit-anyone-anywhere, which contradicts the manager
      // tier (read-all, write-non-sensitive). Keep this preset focused.
      { path: 'team.profile.personal.view', scope: 'all' },
      { path: 'team.profile.personal.edit', scope: 'all' },
      { path: 'team.profile.job.view', scope: 'all' },
      { path: 'team.profile.job.edit', scope: 'all' },
      { path: 'team.profile.documents.view', scope: 'all' },
      { path: 'team.profile.documents.edit', scope: 'all' },
    ],
  },
  {
    key: 'worker',
    labelKey: 'rbac.preset.worker',
    descriptionKey: 'rbac.presetDesc.worker',
    paths: [
      { path: 'team.directory.view', scope: 'self' },
      ...allView('self'),
      // Self-service: own personal contact + own documents only. Pay /
      // bank / statutory / org are read-only on self (owner-managed).
      { path: 'team.profile.personal.edit', scope: 'self' },
      { path: 'team.profile.documents.edit', scope: 'self' },
    ],
  },
];
