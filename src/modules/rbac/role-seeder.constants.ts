import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import type { PermissionScope, SelfProfileEdit } from './schemas/role.schema';
import type { GrantedPermission } from './permission-matcher';

/**
 * Seeded default role library.
 *
 * Seeded automatically on workspace.create + via bootstrap migration for
 * existing workspaces. Every role here is `isSystem: true` but fully
 * editable + deletable-if-unused by the owner — these are DATA presets,
 * not hardcoded logic. No code branches on these role names; the owner
 * reconfigures any of them via the role editor.
 *
 * Access Control Initiative (2026-05-15): scope is explicit on every seeded
 * grant — nothing relies on a fallback default. Grids are grounded in the
 * actual `@RequirePermissions` decorators across the codebase, not guessed;
 * every (module, action) below maps to a real enforced endpoint.
 *
 * RBAC re-architecture Phase 1a (2026-05-19): each role additionally carries
 * `permissionPaths` — hierarchical Team grants from the Permission Registry
 * (`permission-registry.ts`), hand-authored per design §7. These are the
 * source of truth for system roles; `RolesGuard` matches `@RequirePermission`
 * routes against them. The legacy→path converter is for custom roles only.
 * Re-seeded onto existing workspaces by `backfill-role-permission-paths.ts`.
 *
 * Seeded role set (role redesign 2026-06-26, see ROLE-REDESIGN-PLAN.md):
 *   - Partner    — senior leader; everything HR held (payroll, sensitive
 *                  fields, statutory, full Bill & Account, app-access, member
 *                  create/remove). Withheld: irreversible/ownership actions
 *                  (hard-erase, workspace delete, billing, legal CMS).
 *   - Manager    — full operational control across the workspace (`all`).
 *                  UNCHANGED from the prior seed set.
 *   - Accountant — an Employee for their own HR data, plus the full
 *                  Bill & Account (Finance) module workspace-wide.
 *   - Employee   — basic daily-worker baseline; fewer rights than the old
 *                  Karigar (no salary self-service, no comp-off claim).
 * The workspace owner sits above all of them (implicit full access).
 *
 * Legacy retained: DEFAULT_MEMBER_ROLE / DEFAULT_WORKER_ROLE /
 * DEFAULT_HR_ROLE are NO LONGER in DEFAULT_ROLES (not seeded). They are kept
 * as exports only because historical one-shot migrations import them BY NAME
 * (`.name`) to locate old-named DB rows. Do not extend or seed them.
 *
 * ManekHR EXCLUDE enforcement: the four SEEDED roles do NOT grant permissions
 * for any module that is `enabled:false` in the ManekHR preset. Concretely the
 * MACHINES + LOCATIONS module grants and the whole finance.* path slice were
 * removed from the seeded Partner / Manager / Accountant (the Accountant — a
 * Finance-only role in the base ERP — degrades to the Employee baseline). ON +
 * OFF-but-available module grants (team / salary / attendance / shifts /
 * holidays / leave / roles / workspaces) are kept intact. Each removal is marked
 * inline with a `ManekHR EXCLUDE enforcement` comment and a restore note. The
 * non-seeded legacy roles above are left as-is — they never reach a workspace.
 */

export interface DefaultRolePermission {
  module: AppModule;
  actions: ModuleAction[];
  /** Parallel array indexed with `actions[]` — explicit scope per grant. */
  actionScopes: PermissionScope[];
}

export interface DefaultRoleDefinition {
  name: string;
  color: string;
  description: string;
  permissions: DefaultRolePermission[];
  /**
   * Hierarchical Team path grants (RBAC re-architecture Phase 1a). Hand-
   * authored from the Permission Registry per design §7 — the source of
   * truth for system roles. `RolesGuard` matches `@RequirePermission`
   * routes against these; the legacy→path converter is for custom roles.
   */
  permissionPaths: GrantedPermission[];
  /** Self-edit hierarchy policy. Omitted → schema default `'allow'`. */
  selfProfileEdit?: SelfProfileEdit;
}

/**
 * Build a permission grant where every action shares one scope — keeps the
 * `actions[]` / `actionScopes[]` parallel arrays in lockstep so a seed can
 * never drift out of alignment.
 */
function grant(
  module: AppModule,
  actions: ModuleAction[],
  scope: PermissionScope,
): DefaultRolePermission {
  return { module, actions, actionScopes: actions.map(() => scope) };
}

/**
 * Build path grants that share one scope — keeps a seeded role's
 * `permissionPaths` terse and makes a path/scope mismatch impossible.
 * Every path is asserted valid against the registry by the seeder spec.
 */
function paths(scope: PermissionScope, ...pathList: string[]): GrantedPermission[] {
  return pathList.map((path) => ({ path, scope }));
}

/**
 * Member — read-only, self-scoped baseline for an invited employee. Sees
 * only their own attendance + profile; cannot mutate anything.
 */
export const DEFAULT_MEMBER_ROLE: DefaultRoleDefinition = {
  name: 'Member',
  color: '#1677ff',
  description:
    'Read-only baseline access for invited team members — sees only their own attendance and profile.',
  permissions: [
    grant(AppModule.ATTENDANCE, [ModuleAction.VIEW], 'self'),
    grant(AppModule.TEAM, [ModuleAction.VIEW], 'self'),
    grant(AppModule.SHIFTS, [ModuleAction.VIEW], 'self'),
    grant(AppModule.HOLIDAYS, [ModuleAction.VIEW], 'self'),
    grant(AppModule.LEAVE, [ModuleAction.VIEW], 'self'),
  ],
  // Team paths (design §7): read-only, own record only — Personal + Job
  // groups on the View screen. No edit, no sensitive groups, no documents.
  // Attendance rollout Phase A: read-only own attendance record, own leave
  // requests, and own leave balance. Self-scoped, no mutate.
  // Holiday rollout H1: read-only the workspace holiday calendar. Holidays are
  // workspace-global reference data, so the leaf carries no self/all meaning;
  // it is listed under the `self` block only to share the helper, and the
  // registry marks `holidays.calendar.*` as unscoped.
  // Shifts rollout S1: read-only the workspace shift catalog (own shift's
  // times are surfaced via Team + Attendance contexts). Same convention as
  // Holidays - workspace-global reference data, unscoped leaf, listed under
  // the `self` block only to share the helper.
  permissionPaths: paths(
    'self',
    'team.directory.view',
    'team.profile.personal.view',
    'team.profile.job.view',
    'attendance.record.view',
    'leave.request.view',
    'leave.balance.view',
    'holidays.calendar.view',
    'shifts.catalog.view',
  ),
};

/**
 * Worker / Karigar — Member baseline plus self-service: can clock in/out of
 * their own attendance (self-punch) and raise their own attendance-correction
 * requests. Still self-scoped — sees nobody else's data and cannot approve
 * anything. Direct status mark/edit is a manager action (G2/A+); members
 * record via punch and fix via regularization.
 */
export const DEFAULT_WORKER_ROLE: DefaultRoleDefinition = {
  name: 'Worker',
  color: '#13c2c2',
  description:
    'Self-service access — an employee who can view their own attendance, clock in/out, and raise their own correction requests.',
  selfProfileEdit: 'allow',
  permissions: [
    grant(AppModule.ATTENDANCE, [ModuleAction.VIEW, ModuleAction.MANAGE_REGULARIZATIONS], 'self'),
    grant(AppModule.TEAM, [ModuleAction.VIEW], 'self'),
    grant(AppModule.SHIFTS, [ModuleAction.VIEW], 'self'),
    grant(AppModule.HOLIDAYS, [ModuleAction.VIEW], 'self'),
    grant(AppModule.LEAVE, [ModuleAction.VIEW, ModuleAction.APPLY_LEAVE], 'self'),
    // Salary self-service: request an OWN advance, self-apply for an OWN 0%
    // loan, + declare OWN taxes only. Deliberately NOT salary VIEW — a worker
    // can raise an advance/loan request and file their own 80C/HRA investment
    // declaration without seeing salary numbers.
    //   - REQUEST_ADVANCE: inert unless the workspace also has the
    //     `advance_payments` subscription sub-feature AND its advance-request
    //     timing policy is open (AND-gate, like self-punch).
    //   - REQUEST_LOAN: lets a worker self-apply for their OWN interest-free
    //     installment loan. Inert unless the workspace also has the
    //     `loan_management` feature AND `loanConfig.selfApplyEnabled` is on
    //     (both default OFF — AND-gate, exactly like REQUEST_ADVANCE). Creates a
    //     lightweight loan request; the owner later approves it and the system
    //     materializes the real EmployerLoan via LoanService (SoD guard intact).
    //   - DECLARE_TAX (security-review fix HIGH-1, OQ-S6): lets a worker upsert
    //     ONLY their own tax declaration for the current FY. Gated on the
    //     `statutory_tds` subscription sub-feature; the service binds the write to
    //     the caller's own member id and strips the lock flag. A dedicated action
    //     (not salary.edit) so the worker self-declares without an over-broad
    //     salary-edit grant.
    // All three are dedicated self-service actions modelled on APPLY_LEAVE.
    // Existing workspaces need a re-seed/backfill to pick these up.
    // Links: advance-salary-request.controller.ts (REQUEST_ADVANCE self gate),
    // loan-request.controller.ts (REQUEST_LOAN self gate),
    // salary.controller.ts upsertTaxDeclaration (DECLARE_TAX self gate).
    grant(
      AppModule.SALARY,
      [ModuleAction.REQUEST_ADVANCE, ModuleAction.REQUEST_LOAN, ModuleAction.DECLARE_TAX],
      'self',
    ),
  ],
  // Team paths: identical to Member — Worker's self-service extras are
  // attendance-side (punch / regularize), not Team. Read-only own record.
  // Attendance rollout Phase A: self-service - view own attendance,
  // self-punch, raise own leave + comp-off + regularization requests (and
  // cancel them). All self-scoped, no mark/edit, no approval. Self-punch is
  // additionally gated by the workspace policy at request time (Phase C).
  // Holiday rollout H1: read-only the workspace holiday calendar (same as
  // Member). Workspace-global reference data, unscoped leaf, listed here to
  // share the `self` helper.
  // Shifts rollout S1: read-only the workspace shift catalog (same as
  // Member). Workspace-global reference data, unscoped leaf, listed here to
  // share the `self` helper.
  permissionPaths: paths(
    'self',
    'team.directory.view',
    'team.profile.personal.view',
    'team.profile.job.view',
    'attendance.record.view',
    'attendance.selfPunch.create',
    'leave.request.apply',
    'leave.request.view',
    'leave.request.cancel',
    'leave.balance.view',
    'leave.compOff.apply',
    'regularization.request.apply',
    'regularization.request.view',
    'regularization.request.cancel',
    'holidays.calendar.view',
    'shifts.catalog.view',
  ),
};

/**
 * Manager — full operational control across the whole workspace. Manages
 * every member, their attendance, shifts, holidays, and machines. Reads
 * salary but does not edit it; reads the role list (to assign at invite)
 * but cannot author roles. Blocked from editing their own profile record.
 */
export const DEFAULT_MANAGER_ROLE: DefaultRoleDefinition = {
  name: 'Manager',
  color: '#722ed1',
  description:
    'Full operational control — manage every member, their attendance, shifts, schedules, and machines across the workspace.',
  selfProfileEdit: 'block',
  permissions: [
    grant(
      AppModule.ATTENDANCE,
      [
        ModuleAction.VIEW,
        ModuleAction.MARK,
        ModuleAction.EDIT,
        ModuleAction.EXPORT,
        ModuleAction.MANAGE_ANOMALIES,
        ModuleAction.MANAGE_REGULARIZATIONS,
      ],
      'all',
    ),
    grant(
      AppModule.TEAM,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.REMOVE],
      'all',
    ),
    grant(
      AppModule.SHIFTS,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.DELETE],
      'all',
    ),
    grant(
      AppModule.HOLIDAYS,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.DELETE],
      'all',
    ),
    // ManekHR EXCLUDE enforcement: MACHINES module grant removed from the seeded
    // default Manager. Its VIEW (@Get) routes carry NO @RequireSubscription (only
    // the writes do), so a seeded MACHINES.VIEW grant would let a non-owner reach
    // the disabled-module list surfaces on RBAC alone. Dropping the grant
    // RBAC-denies every non-owner; owners are blocked on the web by the
    // ROUTE_MODULES plan gate. Restore this grant if the manufacturing/ops
    // cluster is ever sold.
    grant(AppModule.SALARY, [ModuleAction.VIEW], 'all'),
    // Reporting-person advance review (Phase 3a): a Manager VERIFIES the advance
    // requests of their DIRECT REPORTS (TeamMember.reportsTo edge). Advisory
    // only — verify never changes request status nor blocks the owner approve
    // path. Visibility is a reportsTo-FILTERED read endpoint, NOT a new RBAC
    // scope; review_advance reuses scope='self' (the controller resolves the
    // caller's own teamMemberId and the service filters by reportsTo).
    //
    // This is a SEPARATE salary permission row from the VIEW@all grant above
    // because the helper forces one shared scope per grant() (review_advance is
    // 'self', view is 'all'). It MUST stay AFTER the view row: CallerScopeService
    // .effectiveScope returns on the FIRST matching module row, and salary.service
    // resolves salary.view scope via that method — keeping view first preserves
    // that resolution while the guard (permissionsSatisfy, .some) matches either
    // row. Owner grants this per-member via Grant App Access for non-Manager roles.
    grant(AppModule.SALARY, [ModuleAction.REVIEW_ADVANCE], 'self'),
    // ManekHR EXCLUDE enforcement: LOCATIONS module grant removed from the seeded
    // default Manager (same rationale as MACHINES — disabled ops-cluster module
    // whose VIEW route lacks a subscription gate). Restore if the ops cluster is
    // ever sold.
    grant(AppModule.ROLES, [ModuleAction.VIEW], 'all'),
    grant(AppModule.WORKSPACES, [ModuleAction.VIEW], 'all'),
    grant(
      AppModule.LEAVE,
      [ModuleAction.VIEW, ModuleAction.APPLY_LEAVE, ModuleAction.APPROVE_LEAVE],
      'all',
    ),
  ],
  // Team paths (design §7): full directory + Personal/Job view+edit
  // workspace-wide, Pay read-only, member onboarding. Documents view+edit
  // retained (no regression — legacy TEAM.EDIT covered them). No member
  // delete (HR-only per §7); no Bank/Statutory/Org; no App Access.
  // Attendance rollout Phase A: full operational control workspace-wide -
  // mark/edit/delete any member's attendance, org analytics + export, raw
  // event admin, anomaly review, regularization + leave approval, delegation.
  // No HR-only config (leave types/settings, attendance policy/device) -
  // Manager never held MANAGE_LEAVE / MANAGE_POLICIES / MANAGE_DEVICES.
  permissionPaths: paths(
    'all',
    'team.directory.view',
    'team.profile.personal.view',
    'team.profile.personal.edit',
    'team.profile.job.view',
    'team.profile.job.edit',
    'team.profile.pay.view',
    'team.profile.documents.view',
    'team.profile.documents.edit',
    'team.member.create',
    'attendance.record.view',
    'attendance.record.mark',
    'attendance.record.edit',
    'attendance.record.delete',
    'attendance.selfPunch.create',
    'attendance.analytics.view',
    'attendance.export.export',
    'attendance.events.view',
    'attendance.events.delete',
    'attendance.anomaly.manage',
    'leave.request.apply',
    'leave.request.view',
    'leave.request.cancel',
    'leave.approval.decide',
    'leave.balance.view',
    'leave.compOff.apply',
    'leave.compOff.decide',
    'leave.delegation.manage',
    'regularization.request.apply',
    'regularization.request.view',
    'regularization.request.cancel',
    'regularization.approval.decide',
    'regularization.settings.manage',
    // Holiday rollout H1: manage the workspace holiday calendar, view +
    // create + edit. NOT delete: a holiday delete is a hard, irreversible
    // removal and stays owner/admin-only (mirrors `team.member.delete` being
    // HR-only and `delete_permanent` being owner-only). The leaves are
    // unscoped; the `all` here is inert for them.
    'holidays.calendar.view',
    'holidays.calendar.create',
    'holidays.calendar.edit',
    // Shifts rollout S1: manage the workspace shift catalog, view + create +
    // edit. NOT delete: a shift delete is a hard, irreversible removal and
    // stays owner/admin-only (mirrors `holidays.calendar.delete` and
    // `team.member.delete_permanent`). Unscoped leaves; the `all` here is
    // inert for them.
    'shifts.catalog.view',
    'shifts.catalog.create',
    'shifts.catalog.edit',
    // ManekHR EXCLUDE enforcement: ALL finance.* path grants removed from the
    // seeded default Manager. FINANCE is `enabled:false` in the ManekHR preset.
    // The legacy Bills controller gates ONLY on RBAC (`finance.payable.*`, no
    // @RequireSubscription), so a seeded grant would let a non-owner reach the
    // disabled Bills surface; the finance.invoice/expense/etc. paths back the GST
    // billing UI, also off. Dropping every finance.* path RBAC-denies all
    // non-owners across Bills + Finance; owners are blocked on the web by the
    // ROUTE_MODULES plan gate. Restore the Manager billing/payable slice if the
    // finance cluster is ever sold.
  ),
};

/**
 * HR / Supervisor — everything a Manager can do, plus the sensitive
 * surfaces: payroll (salary edit), attendance device + policy config, and
 * full location management. Blocked from editing their own profile record.
 */
export const DEFAULT_HR_ROLE: DefaultRoleDefinition = {
  name: 'HR',
  color: '#fa8c16',
  description:
    'Everything a Manager can do, plus payroll, statutory exports, and attendance configuration.',
  selfProfileEdit: 'block',
  permissions: [
    grant(
      AppModule.ATTENDANCE,
      [
        ModuleAction.VIEW,
        ModuleAction.MARK,
        ModuleAction.EDIT,
        ModuleAction.EXPORT,
        ModuleAction.MANAGE_ANOMALIES,
        ModuleAction.MANAGE_REGULARIZATIONS,
        ModuleAction.MANAGE_DEVICES,
        ModuleAction.MANAGE_POLICIES,
      ],
      'all',
    ),
    grant(
      AppModule.TEAM,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.REMOVE],
      'all',
    ),
    grant(
      AppModule.SHIFTS,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.DELETE],
      'all',
    ),
    grant(
      AppModule.HOLIDAYS,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.DELETE],
      'all',
    ),
    grant(
      AppModule.MACHINES,
      [
        ModuleAction.VIEW,
        ModuleAction.CREATE,
        ModuleAction.EDIT,
        ModuleAction.REMOVE,
        ModuleAction.ASSIGN,
      ],
      'all',
    ),
    // DECLARE_TAX@all (security-review fix HIGH-1, OQ-S6): the tax-declaration
    // upsert route now gates on `salary.declare_tax`, not salary.edit, so HR needs
    // this explicit grant to keep its existing all-scoped upsert path (HR enters
    // declarations on behalf of any member + may lock at the cutoff). Owner
    // bypasses RolesGuard, so this is the HR-only top-up.
    grant(
      AppModule.SALARY,
      [ModuleAction.VIEW, ModuleAction.EDIT, ModuleAction.SENSITIVE_VIEW, ModuleAction.DECLARE_TAX],
      'all',
    ),
    grant(
      AppModule.LOCATIONS,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.REMOVE],
      'all',
    ),
    grant(AppModule.ROLES, [ModuleAction.VIEW], 'all'),
    grant(AppModule.WORKSPACES, [ModuleAction.VIEW], 'all'),
    grant(
      AppModule.LEAVE,
      [
        ModuleAction.VIEW,
        ModuleAction.APPLY_LEAVE,
        ModuleAction.APPROVE_LEAVE,
        ModuleAction.MANAGE_LEAVE,
      ],
      'all',
    ),
  ],
  // Team paths (design §7): Manager + every sensitive group (Pay edit, Bank,
  // Statutory, Org) view+edit, member offboarding, and App Access management.
  // Attendance rollout Phase A: everything Manager holds, plus the HR-only
  // config surfaces - attendance policy + device management, leave-type +
  // leave-settings administration. (Regularization settings already ride the
  // shared regularization grant, held by Manager too.)
  permissionPaths: paths(
    'all',
    'team.directory.view',
    'team.profile.personal.view',
    'team.profile.personal.edit',
    'team.profile.job.view',
    'team.profile.job.edit',
    'team.profile.pay.view',
    'team.profile.pay.edit',
    'team.profile.bank.view',
    'team.profile.bank.edit',
    'team.profile.statutory.view',
    'team.profile.statutory.edit',
    'team.profile.org.view',
    'team.profile.org.edit',
    'team.profile.documents.view',
    'team.profile.documents.edit',
    'team.member.create',
    'team.member.delete',
    'team.appAccess.manage',
    'attendance.record.view',
    'attendance.record.mark',
    'attendance.record.edit',
    'attendance.record.delete',
    'attendance.selfPunch.create',
    'attendance.analytics.view',
    'attendance.export.export',
    'attendance.events.view',
    'attendance.events.delete',
    'attendance.anomaly.manage',
    'attendance.device.manage',
    'attendance.policy.manage',
    'leave.request.apply',
    'leave.request.view',
    'leave.request.cancel',
    'leave.approval.decide',
    'leave.balance.view',
    'leave.compOff.apply',
    'leave.compOff.decide',
    'leave.type.manage',
    'leave.settings.manage',
    'leave.delegation.manage',
    'regularization.request.apply',
    'regularization.request.view',
    'regularization.request.cancel',
    'regularization.approval.decide',
    'regularization.settings.manage',
    // Holiday rollout H1: HR matches Manager on the holiday calendar, view +
    // create + edit. delete stays owner/admin-only (a hard, irreversible
    // removal), so it is NOT seeded here either; the owner re-grants it via
    // the matrix if desired. Unscoped leaves; `all` is inert for them.
    'holidays.calendar.view',
    'holidays.calendar.create',
    'holidays.calendar.edit',
    // Shifts rollout S1: HR matches Manager on the shift catalog, view +
    // create + edit. delete stays owner/admin-only (a hard, irreversible
    // removal), so it is NOT seeded here either; the owner re-grants it via
    // the matrix if desired. Unscoped leaves; `all` is inert for them.
    'shifts.catalog.view',
    'shifts.catalog.create',
    'shifts.catalog.edit',
    // Finance billing slice (design spec 2026-06-01 SS6.B): HR holds the
    // FULL billing surface - everything Manager has PLUS the sensitive
    // actions Manager is denied: `finance.invoice.delete` (void),
    // `finance.invoice.send` (cost-bearing email/SMS/WhatsApp), and
    // `finance.settings.manage` (branding / numbering / compliance config).
    // Scoped leaves take `all`; unscoped leaves treat `all` as the inert
    // sentinel.
    // Legacy AP/AR Bills tracker (Finance/Bills hardening OQ-FB-2): HR holds the
    // FULL payable surface — everything Manager has PLUS `finance.payable.delete`
    // (the sensitive soft-delete of a statutory AP/AR record, owner/HR-only).
  ),
};

// ── New seeded role set (role redesign 2026-06-26) ─────────────────────────
// Partner / Manager / Accountant / Employee. See ROLE-REDESIGN-PLAN.md. Manager
// (DEFAULT_MANAGER_ROLE above) is reused UNCHANGED. The three roles below are
// the redesigned definitions; every path is asserted valid against the registry
// by the role-seeder constants spec.

/**
 * Partner — senior leader, "almost all permissions". Holds everything the old
 * HR seed held (payroll, sensitive employee fields, statutory exports,
 * attendance device/policy config, full location management) PLUS the full
 * Bill & Account (Finance) module, app-access management, and member
 * create/remove. The only things withheld (kept Owner-only) are the
 * irreversible / ownership-level actions — `team.member.delete_permanent`
 * (hard erase), workspace delete / ownership transfer, subscription / plan /
 * billing changes, and the legal/policy CMS. None of those are seeded into any
 * role, so they stay Owner-only purely by omission.
 *
 * Replaces the retired HR seed; the grant set equals the old DEFAULT_HR_ROLE,
 * re-authored explicitly here so the seed stays self-documenting + auditable
 * (ROLE-REDESIGN-PLAN.md §1). Blocked from editing their own profile record
 * (separation-of-duties; the workspace Owner bypasses RolesGuard).
 */
export const DEFAULT_PARTNER_ROLE: DefaultRoleDefinition = {
  name: 'Partner',
  color: '#fa8c16',
  description:
    'Senior leader — payroll, sensitive employee records, statutory exports, full Bill & Account, app access, and member management. Everything except owner-only actions (workspace delete, billing, permanent erase).',
  selfProfileEdit: 'block',
  permissions: [
    grant(
      AppModule.ATTENDANCE,
      [
        ModuleAction.VIEW,
        ModuleAction.MARK,
        ModuleAction.EDIT,
        ModuleAction.EXPORT,
        ModuleAction.MANAGE_ANOMALIES,
        ModuleAction.MANAGE_REGULARIZATIONS,
        ModuleAction.MANAGE_DEVICES,
        ModuleAction.MANAGE_POLICIES,
      ],
      'all',
    ),
    grant(
      AppModule.TEAM,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.REMOVE],
      'all',
    ),
    grant(
      AppModule.SHIFTS,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.DELETE],
      'all',
    ),
    grant(
      AppModule.HOLIDAYS,
      [ModuleAction.VIEW, ModuleAction.CREATE, ModuleAction.EDIT, ModuleAction.DELETE],
      'all',
    ),
    // ManekHR EXCLUDE enforcement: MACHINES module grant removed from the seeded
    // default Partner (disabled ops-cluster module whose VIEW route lacks a
    // subscription gate). Restore if the manufacturing/ops cluster is ever sold.
    grant(
      AppModule.SALARY,
      [ModuleAction.VIEW, ModuleAction.EDIT, ModuleAction.SENSITIVE_VIEW, ModuleAction.DECLARE_TAX],
      'all',
    ),
    // ManekHR EXCLUDE enforcement: LOCATIONS module grant removed from the seeded
    // default Partner (same rationale as MACHINES). Restore if the ops cluster is
    // ever sold.
    grant(AppModule.ROLES, [ModuleAction.VIEW], 'all'),
    grant(AppModule.WORKSPACES, [ModuleAction.VIEW], 'all'),
    grant(
      AppModule.LEAVE,
      [
        ModuleAction.VIEW,
        ModuleAction.APPLY_LEAVE,
        ModuleAction.APPROVE_LEAVE,
        ModuleAction.MANAGE_LEAVE,
      ],
      'all',
    ),
  ],
  permissionPaths: paths(
    'all',
    // Team — full directory + every profile group (incl. sensitive) view+edit,
    // member onboarding + offboarding, and App Access management.
    'team.directory.view',
    'team.profile.personal.view',
    'team.profile.personal.edit',
    'team.profile.job.view',
    'team.profile.job.edit',
    'team.profile.pay.view',
    'team.profile.pay.edit',
    'team.profile.bank.view',
    'team.profile.bank.edit',
    'team.profile.statutory.view',
    'team.profile.statutory.edit',
    'team.profile.org.view',
    'team.profile.org.edit',
    'team.profile.documents.view',
    'team.profile.documents.edit',
    'team.member.create',
    'team.member.delete',
    'team.appAccess.manage',
    // Attendance — full operational control + HR config (device + policy).
    'attendance.record.view',
    'attendance.record.mark',
    'attendance.record.edit',
    'attendance.record.delete',
    'attendance.selfPunch.create',
    'attendance.analytics.view',
    'attendance.export.export',
    'attendance.events.view',
    'attendance.events.delete',
    'attendance.anomaly.manage',
    'attendance.device.manage',
    'attendance.policy.manage',
    // Leave — full lifecycle + approvals + type/settings/delegation admin.
    'leave.request.apply',
    'leave.request.view',
    'leave.request.cancel',
    'leave.approval.decide',
    'leave.balance.view',
    'leave.compOff.apply',
    'leave.compOff.decide',
    'leave.type.manage',
    'leave.settings.manage',
    'leave.delegation.manage',
    // Regularization — full lifecycle + approvals + settings.
    'regularization.request.apply',
    'regularization.request.view',
    'regularization.request.cancel',
    'regularization.approval.decide',
    'regularization.settings.manage',
    // Holidays / Shifts — view + create + edit. delete stays Owner-only.
    'holidays.calendar.view',
    'holidays.calendar.create',
    'holidays.calendar.edit',
    'shifts.catalog.view',
    'shifts.catalog.create',
    'shifts.catalog.edit',
    // ManekHR EXCLUDE enforcement: ALL finance.* path grants removed from the
    // seeded default Partner. FINANCE is `enabled:false` in the ManekHR preset;
    // the legacy Bills controller gates only on RBAC (no @RequireSubscription),
    // so a seeded grant would let a non-owner reach the disabled Bills + Finance
    // surfaces. Dropping them RBAC-denies all non-owners (incl. the sensitive
    // `finance.invoice.delete` / `finance.payable.delete` / `finance.settings.manage`).
    // Restore the Partner billing slice if the finance cluster is ever sold.
  ),
};

/**
 * Employee — basic daily-worker baseline. Sees only their own data: views the
 * holiday calendar + shift catalog, views + self-edits their own personal
 * contact, self-punches, applies for / cancels their own leave, and raises
 * their own attendance-correction requests. Fewer rights than the old Karigar:
 * NO salary self-service (no advance, no 0% loan, no tax declaration), NO
 * comp-off claim, NO document edit. self-punch + regularization are
 * additionally gated by the workspace self-service policy at request time.
 * selfProfileEdit allow (edits their own record).
 */
export const DEFAULT_EMPLOYEE_ROLE: DefaultRoleDefinition = {
  name: 'Employee',
  color: '#1677ff',
  description:
    'Basic worker access — view own profile, attendance and salary, clock in/out, apply for own leave, and request own advances/loans. No finance or team-management access.',
  selfProfileEdit: 'allow',
  permissions: [
    grant(AppModule.ATTENDANCE, [ModuleAction.VIEW], 'self'),
    grant(AppModule.TEAM, [ModuleAction.VIEW], 'self'),
    grant(AppModule.SHIFTS, [ModuleAction.VIEW], 'self'),
    grant(AppModule.HOLIDAYS, [ModuleAction.VIEW], 'self'),
    grant(AppModule.LEAVE, [ModuleAction.VIEW, ModuleAction.APPLY_LEAVE], 'self'),
    // Salary self-service baseline (owner directive 2026-07-03): every employee
    // can see their OWN payslips/ledger (VIEW self), request an OWN advance,
    // and self-apply for an OWN 0% loan (same AND-gates as the legacy Worker
    // role: advance_payments / loan_management+selfApplyEnabled subscription
    // features; inert until those are on). Deliberately NO declare_tax — tax
    // declaration is an advanced statutory feature the owner grants per role
    // when needed (owner directive 2026-07-03; migration 0056 stripped it).
    // SENSITIVE_VIEW included (owner directive 2026-07-03) so an employee sees
    // their OWN bank/PAN fields on their payslips; the salary read surface is
    // still bounded by VIEW@self. No edit / export / add_payment. Existing
    // workspaces pick changes up via migration 0055 (bump
    // RBAC_BASELINE_CHECKSUMS.systemRoles on change).
    grant(
      AppModule.SALARY,
      [
        ModuleAction.VIEW,
        ModuleAction.SENSITIVE_VIEW,
        ModuleAction.REQUEST_ADVANCE,
        ModuleAction.REQUEST_LOAN,
      ],
      'self',
    ),
  ],
  permissionPaths: paths(
    'self',
    'team.directory.view',
    'team.profile.personal.view',
    'team.profile.personal.edit',
    'team.profile.job.view',
    'attendance.record.view',
    'attendance.selfPunch.create',
    'leave.request.apply',
    'leave.request.view',
    'leave.request.cancel',
    'leave.balance.view',
    'regularization.request.apply',
    'regularization.request.view',
    'regularization.request.cancel',
    'holidays.calendar.view',
    'shifts.catalog.view',
  ),
};

/**
 * Accountant — an Employee for their own HR data. In the base ERP this role
 * additionally owned the FULL Bill & Account (Finance) module workspace-wide.
 *
 * ManekHR EXCLUDE enforcement: FINANCE is `enabled:false` in the ManekHR preset,
 * so the entire finance.* slice is removed from the seeded Accountant — its only
 * differentiator over Employee. The role is kept seeded (HARD RULE 2 — modules
 * stay dormant, presets are not ripped out) so it degrades cleanly to the shared
 * Employee self-service baseline; the owner can delete the unused role or, if the
 * finance cluster is ever sold, restore the finance path block below.
 */
export const DEFAULT_ACCOUNTANT_ROLE: DefaultRoleDefinition = {
  name: 'Accountant',
  color: '#52c41a',
  description:
    'Basic own-employee self-service. (Bill & Account / Finance access is off in this edition.)',
  selfProfileEdit: 'allow',
  // Same self-service baseline as Employee (flat + path) — spread to prevent drift.
  permissions: [...DEFAULT_EMPLOYEE_ROLE.permissions],
  // ManekHR EXCLUDE enforcement: the FULL Bill & Account (Finance) `all`-scoped
  // path block (finance.invoice.* / creditNote / expense / payment / payable.* /
  // report / gst / settings) was removed here — FINANCE is off in the ManekHR
  // preset and its Bills controller gates only on RBAC. Restore that block if
  // the finance cluster is ever sold.
  permissionPaths: [...DEFAULT_EMPLOYEE_ROLE.permissionPaths],
};

/**
 * Seeded in this order: Partner → Manager → Accountant → Employee. All four
 * land in every workspace; the owner picks one at invite time and tunes it
 * (or builds a custom role) afterwards. (Role redesign 2026-06-26.)
 */
export const DEFAULT_ROLES: readonly DefaultRoleDefinition[] = [
  DEFAULT_PARTNER_ROLE,
  DEFAULT_MANAGER_ROLE,
  DEFAULT_ACCOUNTANT_ROLE,
  DEFAULT_EMPLOYEE_ROLE,
] as const;
