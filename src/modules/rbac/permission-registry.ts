/**
 * THE PERMISSION REGISTRY — the declarative catalog of every grantable
 * permission. Single source of truth: the matrix UI, RolesGuard, and the
 * nav builder all read this. Grants (what a role HAS) live in the DB; the
 * registry defines what CAN be granted.
 *
 * Phase 0 populates the `team` module. Other modules are added in their
 * own rollout phases. See rbac-rearchitecture-design-19-05-2026.md §3, §7.
 */

/** Scope tag — actor operates on own data ('self') or workspace-wide ('all'). */
export type PermissionScope = 'self' | 'all';

/** A leaf action available on a registry node. */
export interface PermissionActionDef {
  /** Action segment, e.g. 'view', 'edit', 'create'. */
  action: string;
  /** Whether the self/all scope axis applies to this action. */
  scoped: boolean;
  /** Per-ACTION prerequisite grants. Merged with the node-level `requires`
   *  at validation time. Use this when a single action on a feature needs
   *  more grants than its siblings — e.g. `team.member.create` needs every
   *  `team.profile.*.edit` path (because the create form may set values
   *  in every field group), but `team.member.delete` does not. */
  requires?: string[];
}

/** A node in the permission tree — a feature or sub-feature. */
export interface PermissionNode {
  /** Path segment key, e.g. 'profile', 'bank'. */
  key: string;
  /** i18n label key for the matrix UI. */
  labelKey: string;
  /** HR-sensitive — hidden by default in the matrix + member views. */
  sensitive?: boolean;
  /** Industry SoD: a non-owner cannot edit this leaf on their OWN record,
   *  even when their grant nominally scopes to `all`. Owner bypass intact. */
  sodOwnerOnlyOnSelf?: boolean;
  /** Cross-leaf prerequisite grants required to use this node's actions.
   *  Each string is `<path>` or `<path>@<scope>`. Validated at grant-save. */
  requires?: string[];
  /** Child sub-feature nodes. */
  children?: PermissionNode[];
  /** Leaf actions available directly on this node. */
  actions?: PermissionActionDef[];
}

/** A top-level module in the permission tree. */
export interface PermissionModuleDef {
  /** Module key — mirrors AppModule enum values. */
  module: string;
  labelKey: string;
  features: PermissionNode[];
}

const VIEW_EDIT: PermissionActionDef[] = [
  { action: 'view', scoped: true },
  { action: 'edit', scoped: true },
];

export const PERMISSION_REGISTRY: PermissionModuleDef[] = [
  {
    module: 'team',
    labelKey: 'rbac.module.team',
    features: [
      {
        key: 'directory',
        labelKey: 'rbac.team.directory',
        actions: [{ action: 'view', scoped: true }],
      },
      {
        key: 'member',
        labelKey: 'rbac.team.member',
        actions: [
          {
            // Creating a member opens a wide form that can write into every
            // profile field-group; `team.service.create`'s service-layer
            // gates each group separately. Granting `member.create` MUST
            // therefore bundle every profile-edit path so the creator can
            // actually finish the form without hitting a 403 mid-flow. The
            // FE `resolveImplicitDeps` auto-fills these when the owner
            // toggles `member.create@all` in the override matrix — one
            // click → all paths granted together.
            action: 'create',
            scoped: false,
            requires: [
              'team.directory.view@all',
              'team.profile.personal.edit@all',
              'team.profile.job.edit@all',
              'team.profile.pay.edit@all',
              'team.profile.bank.edit@all',
              'team.profile.statutory.edit@all',
              'team.profile.org.edit@all',
              'team.profile.documents.edit@all',
            ],
          },
          {
            // Archive (soft-delete) + restore. Read-shaped — just needs
            // visibility into the directory to find the target row.
            action: 'delete',
            scoped: false,
            requires: ['team.directory.view@all'],
          },
          {
            // Permanent (irreversible) delete of an already-archived member's
            // row. Split from `delete` (archive/restore) so an owner can let
            // managers archive WITHOUT granting irreversible deletion.
            // Owner-only by default — intentionally NOT seeded into the
            // Manager / HR role presets.
            action: 'delete_permanent',
            scoped: false,
            requires: ['team.directory.view@all'],
          },
        ],
      },
      {
        key: 'profile',
        // String-only label. Sub-features live under `rbac.team.profile.*`
        // (a JSON object), so the feature-level label needs a non-colliding
        // key — next-intl rejects resolving a parent node to a string.
        labelKey: 'rbac.team.profileGroup',
        children: [
          { key: 'personal', labelKey: 'rbac.team.profile.personal', actions: VIEW_EDIT },
          { key: 'job', labelKey: 'rbac.team.profile.job', actions: VIEW_EDIT },
          {
            key: 'pay',
            labelKey: 'rbac.team.profile.pay',
            sensitive: true,
            sodOwnerOnlyOnSelf: true,
            actions: VIEW_EDIT,
          },
          {
            key: 'bank',
            labelKey: 'rbac.team.profile.bank',
            sensitive: true,
            sodOwnerOnlyOnSelf: true,
            actions: VIEW_EDIT,
          },
          {
            key: 'statutory',
            labelKey: 'rbac.team.profile.statutory',
            sensitive: true,
            sodOwnerOnlyOnSelf: true,
            actions: VIEW_EDIT,
          },
          {
            key: 'org',
            labelKey: 'rbac.team.profile.org',
            sensitive: true,
            sodOwnerOnlyOnSelf: true,
            actions: VIEW_EDIT,
          },
          { key: 'documents', labelKey: 'rbac.team.profile.documents', actions: VIEW_EDIT },
        ],
      },
      {
        key: 'appAccess',
        labelKey: 'rbac.team.appAccess',
        sensitive: true,
        requires: ['team.directory.view@all', 'team.profile.org.view@all'],
        actions: [{ action: 'manage', scoped: false }],
      },
    ],
  },
  {
    // ATTENDANCE — daily attendance records, member self-punch, org-wide
    // analytics, and the device / policy / anomaly admin surfaces. Self-punch
    // is additionally AND-gated at request time by the workspace
    // `selfServiceConfig.selfPunch` policy (the grant is necessary, not
    // sufficient). Routes are migrated from the legacy flat
    // `@RequirePermissions(AppModule.ATTENDANCE, ...)` decorator in the
    // Attendance rollout Phase B; the converter (`permission-path.converter`)
    // bridges existing custom-role flat grants.
    module: 'attendance',
    labelKey: 'rbac.module.attendance',
    features: [
      {
        key: 'record',
        labelKey: 'rbac.attendance.record',
        actions: [
          { action: 'view', scoped: true },
          // G2/A+ (2026-05-24): mark + edit are manager-only writes. Members
          // self-serve via selfPunch.create@self (clock-in) and correct via
          // regularization.request.apply@self (manager-approved). A direct
          // self status-set/edit has no member UI and would bypass the
          // punch/approval trail (SoD), so `self` scope is not offered.
          { action: 'mark', scoped: false },
          { action: 'edit', scoped: false },
          { action: 'delete', scoped: true },
        ],
      },
      {
        // Member self check-in / check-out. A `self`-scoped capability; the
        // workspace policy gate decides whether it is actually usable.
        key: 'selfPunch',
        labelKey: 'rbac.attendance.selfPunch',
        actions: [{ action: 'create', scoped: true }],
      },
      {
        // Org-wide dashboards (overview / grid / overtime / compliance /
        // summary / live-presence). No `self` meaning — workspace-level.
        key: 'analytics',
        labelKey: 'rbac.attendance.analytics',
        requires: ['attendance.record.view@all'],
        actions: [{ action: 'view', scoped: false }],
      },
      {
        key: 'export',
        labelKey: 'rbac.attendance.export',
        sensitive: true,
        requires: ['attendance.record.view@all'],
        actions: [{ action: 'export', scoped: false }],
      },
      {
        // Raw punch-event stream + admin event voids / day deletions.
        key: 'events',
        labelKey: 'rbac.attendance.events',
        requires: ['attendance.record.view@all'],
        actions: [
          { action: 'view', scoped: false },
          { action: 'delete', scoped: false },
        ],
      },
      {
        key: 'anomaly',
        labelKey: 'rbac.attendance.anomaly',
        actions: [{ action: 'manage', scoped: false }],
      },
      {
        key: 'device',
        labelKey: 'rbac.attendance.device',
        actions: [{ action: 'manage', scoped: false }],
      },
      {
        key: 'policy',
        labelKey: 'rbac.attendance.policy',
        actions: [{ action: 'manage', scoped: false }],
      },
    ],
  },
  {
    // LEAVE — request lifecycle (apply / view / cancel), the approval
    // workflow, balances, comp-off, and the leave-type / settings / delegation
    // admin surfaces. A non-owner is blocked from deciding their OWN request
    // at the service layer (SoD). Migrated in the Attendance rollout Phase B.
    module: 'leave',
    labelKey: 'rbac.module.leave',
    features: [
      {
        key: 'request',
        labelKey: 'rbac.leave.request',
        actions: [
          { action: 'apply', scoped: true },
          {
            // The My Leave page loads balances + request history + the type
            // catalogue together; balances ride a SEPARATE leaf
            // (`leave.balance.view`). Bundle it here so granting self-service
            // leave-request view yields a complete, non-blank page — the
            // balance widget needs its own grant. The matrix auto-fills it via
            // `resolveImplicitDeps` when this leaf is toggled.
            action: 'view',
            scoped: true,
            requires: ['leave.balance.view@self'],
          },
          { action: 'cancel', scoped: true },
        ],
      },
      {
        key: 'approval',
        labelKey: 'rbac.leave.approval',
        requires: ['leave.request.view@all'],
        actions: [{ action: 'decide', scoped: false }],
      },
      {
        key: 'balance',
        labelKey: 'rbac.leave.balance',
        actions: [{ action: 'view', scoped: true }],
      },
      {
        key: 'compOff',
        labelKey: 'rbac.leave.compOff',
        actions: [
          {
            // The My Comp-off page reads the caller's own comp-off lots +
            // requests through `leave.request.view` (self), and shows balances
            // alongside the My Leave self-service set. Bundle the same read
            // pair so granting self-service comp-off claim loads a complete
            // page (mirrors the `leave.request.view` edge above). `decide` is
            // the approver action and keeps no self-read requirement.
            action: 'apply',
            scoped: true,
            requires: ['leave.request.view@self', 'leave.balance.view@self'],
          },
          { action: 'decide', scoped: false },
        ],
      },
      {
        key: 'type',
        labelKey: 'rbac.leave.type',
        actions: [{ action: 'manage', scoped: false }],
      },
      {
        key: 'settings',
        labelKey: 'rbac.leave.settings',
        actions: [{ action: 'manage', scoped: false }],
      },
      {
        key: 'delegation',
        labelKey: 'rbac.leave.delegation',
        requires: ['leave.approval.decide'],
        actions: [{ action: 'manage', scoped: false }],
      },
    ],
  },
  {
    // REGULARIZATION — attendance-correction request lifecycle + approval +
    // settings. Enforced today under the legacy `AppModule.ATTENDANCE` +
    // `MANAGE_REGULARIZATIONS` action (one coarse action covering raise,
    // approve, and configure); the path model splits them. A non-owner is
    // blocked from deciding their OWN request at the service layer (SoD).
    module: 'regularization',
    labelKey: 'rbac.module.regularization',
    features: [
      {
        key: 'request',
        labelKey: 'rbac.regularization.request',
        actions: [
          { action: 'apply', scoped: true },
          { action: 'view', scoped: true },
          { action: 'cancel', scoped: true },
        ],
      },
      {
        key: 'approval',
        labelKey: 'rbac.regularization.approval',
        requires: ['regularization.request.view@all'],
        actions: [{ action: 'decide', scoped: false }],
      },
      {
        key: 'settings',
        labelKey: 'rbac.regularization.settings',
        actions: [{ action: 'manage', scoped: false }],
      },
    ],
  },
  {
    // HOLIDAYS - the workspace holiday calendar. Reference data, NOT
    // member-owned: every member who can see the calendar reads the same
    // rows, so the self/all scope axis does not apply (all actions are
    // `scoped: false`). The spine is binary: `view` (any member) vs
    // `create` / `edit` / `delete` (manager+). `delete` is a hard,
    // irreversible removal, so it is owner/admin-only, intentionally NOT
    // seeded into the Manager / HR role presets (mirrors
    // `team.member.delete_permanent`). Routes are migrated from the
    // legacy flat `@RequirePermissions(AppModule.HOLIDAYS, ...)` decorator in
    // the Holiday rollout H1; the converter (`permission-path.converter`)
    // bridges existing custom-role flat grants.
    module: 'holidays',
    labelKey: 'rbac.module.holidays',
    features: [
      {
        key: 'calendar',
        labelKey: 'rbac.holidays.calendar',
        actions: [
          { action: 'view', scoped: false },
          { action: 'create', scoped: false },
          { action: 'edit', scoped: false },
          {
            // Hard delete of a holiday row, irreversible. Owner/admin-only by
            // default; deliberately omitted from the Manager / HR presets so
            // an owner can let managers add + edit holidays WITHOUT granting
            // destructive removal (mirrors how `team.member.delete_permanent`
            // is owner-only purely by preset omission, not a flag).
            action: 'delete',
            scoped: false,
          },
        ],
      },
    ],
  },
  {
    // SHIFTS - the workspace shift catalog (Morning / Day / Evening / Night
    // templates). Reference data, NOT member-owned: every member who can
    // see the catalog reads the same rows (own shift times in Team +
    // Attendance contexts; managers picking a shift to assign), so the
    // self/all scope axis does not apply (all actions are `scoped: false`).
    // The spine is binary: `view` (any member who needs to see their
    // shift's times, so every seeded preset gets it) vs `create` / `edit`
    // / `delete` (manager+). `delete` is a hard, irreversible removal, so
    // it is owner/admin-only, intentionally NOT seeded into the Manager /
    // HR role presets (mirrors `holidays.calendar.delete` and
    // `team.member.delete_permanent`). Routes are migrated from the legacy
    // mixed `@AuthenticatedOnly` (findAll) + `@RequirePermissions(AppModule.SHIFTS, ...)`
    // (writes) decorators in the Shifts rollout S1; the converter
    // (`permission-path.converter`) bridges existing custom-role flat grants.
    module: 'shifts',
    labelKey: 'rbac.module.shifts',
    features: [
      {
        key: 'catalog',
        labelKey: 'rbac.shifts.catalog',
        actions: [
          { action: 'view', scoped: false },
          { action: 'create', scoped: false },
          { action: 'edit', scoped: false },
          {
            // Hard delete of a shift row, irreversible. Owner/admin-only by
            // default; deliberately omitted from the Manager / HR presets so
            // an owner can let managers add + edit shifts WITHOUT granting
            // destructive removal (mirrors how `holidays.calendar.delete` and
            // `team.member.delete_permanent` are owner-only purely by preset
            // omission, not a flag).
            action: 'delete',
            scoped: false,
          },
        ],
      },
    ],
  },
  {
    // FINANCE (billing surface only) - GST sales invoicing, credit notes,
    // expenses, payments, reports, GST + settings config. This is the FIRST
    // slice of the finance module lifted onto the path model (design spec
    // 2026-06-01-finance-billing-module-design.md SS6.B / SS2B); the other
    // ~30 finance sub-modules still run the legacy flat
    // `@RequirePermissions(AppModule.FINANCE, ...)` decorator and are migrated
    // in later slices. `AppModule.FINANCE = 'finance'` already exists, so no
    // enum change was needed.
    //
    // Scope model: a voucher is created by a member, so the invoice / expense
    // / payment leaves carry the self/all axis (a `self`-scoped member sees
    // only their own vouchers; the service narrows). Reports, GST and settings
    // are workspace-level config with no self meaning (unscoped). Sensitive
    // marks flag the cost-bearing / irreversible / statutory actions
    // (send = email/SMS/WhatsApp spend; delete + post + creditNote.create =
    // ledger-affecting; gst + settings = compliance config) so the matrix
    // hides them by default, mirroring the Team sensitive groups.
    module: 'finance',
    labelKey: 'rbac.module.finance',
    features: [
      {
        key: 'invoice',
        labelKey: 'rbac.finance.invoice',
        actions: [
          { action: 'view', scoped: true },
          { action: 'create', scoped: true },
          { action: 'edit', scoped: true },
          {
            // Soft-delete / void of a draft invoice. Sensitive - removes a
            // billing document from the active set.
            action: 'delete',
            scoped: true,
          },
          {
            // Post (finalise) a draft into a numbered, ledger-affecting tax
            // invoice. Sensitive - the maker-checker / accounting boundary.
            action: 'post',
            scoped: true,
          },
          {
            // Multi-channel send (email / WhatsApp / SMS). Sensitive +
            // cost-bearing - every send spends communication credits, so it
            // is gated and hidden by default even for members who can view.
            // Unscoped: sending is an outbound act on a specific voucher, not
            // a self/all read axis.
            action: 'send',
            scoped: false,
          },
        ],
      },
      {
        key: 'creditNote',
        labelKey: 'rbac.finance.creditNote',
        // Sensitive - a credit note reverses output tax + invoice
        // outstanding (Sec 34 / Rule 53); ledger-affecting and statutory.
        sensitive: true,
        actions: [{ action: 'create', scoped: true }],
      },
      {
        key: 'expense',
        labelKey: 'rbac.finance.expense',
        actions: [
          { action: 'view', scoped: true },
          { action: 'create', scoped: true },
        ],
      },
      {
        // Legacy AP/AR Bills tracker (Finance/Bills hardening OQ-FB-2). The
        // standalone `bills` surface (BillsController) was on the DEPRECATED
        // `AppModule.BILLS` flat permission with no scope, so a Worker/Karigar
        // holding BILLS.VIEW could list every workspace bill. Bills are company
        // financials, NOT worker self-data, so this is migrated onto the FINANCE
        // path model with its own `payable` feature. Seeded ONLY to Manager + HR
        // (and Owner implicitly) — the Karigar/Worker preset gets ZERO finance.*
        // grants, removing their bills access entirely. recordPayment is a
        // distinct leaf so a workspace can grant "view + record payment" without
        // granting create/edit/delete. delete is sensitive (it soft-deletes a
        // statutory AP/AR record). Workspace-scoped, not self (OQ-FB-4): finance
        // is organizational, so a holder sees ALL of the workspace's bills.
        key: 'payable',
        labelKey: 'rbac.finance.payable',
        actions: [
          { action: 'view', scoped: true },
          { action: 'create', scoped: true },
          { action: 'edit', scoped: true },
          { action: 'recordPayment', scoped: true },
          // Soft-deletes a Bill (never hard-erases). Sensitive — removes an
          // AP/AR record from the active set.
          { action: 'delete', scoped: true },
        ],
      },
      {
        key: 'payment',
        labelKey: 'rbac.finance.payment',
        actions: [{ action: 'record', scoped: true }],
      },
      {
        // Org-wide finance dashboards + party / P&L reports. No self meaning -
        // workspace-level, so the action is unscoped (mirrors
        // `attendance.analytics.view`).
        key: 'report',
        labelKey: 'rbac.finance.report',
        actions: [{ action: 'view', scoped: false }],
      },
      {
        // GST configuration (rates, returns, e-invoice / e-way settings).
        // Sensitive compliance surface, unscoped.
        key: 'gst',
        labelKey: 'rbac.finance.gst',
        sensitive: true,
        actions: [{ action: 'manage', scoped: false }],
      },
      {
        // Finance / firm settings (branding, numbering series, compliance
        // profile). Sensitive admin surface, unscoped. Owner / HR only by
        // preset - deliberately omitted from the Manager seed (mirrors how
        // `attendance.policy.manage` is HR-only).
        key: 'settings',
        labelKey: 'rbac.finance.settings',
        sensitive: true,
        actions: [{ action: 'manage', scoped: false }],
      },
    ],
  },
];

let _leafPathCache: Set<string> | null = null;

function buildLeafPaths(): Set<string> {
  const paths = new Set<string>();
  const walk = (prefix: string, node: PermissionNode): void => {
    const nodePath = `${prefix}.${node.key}`;
    for (const a of node.actions ?? []) paths.add(`${nodePath}.${a.action}`);
    for (const child of node.children ?? []) walk(nodePath, child);
  };
  for (const mod of PERMISSION_REGISTRY) {
    for (const feature of mod.features) walk(mod.module, feature);
  }
  return paths;
}

/** Every grantable leaf path in the registry (memoised). */
export function allPermissionPaths(): Set<string> {
  if (!_leafPathCache) _leafPathCache = buildLeafPaths();
  return _leafPathCache;
}

/** True when `path` is a grantable leaf permission in the registry. */
export function isValidPermissionPath(path: string): boolean {
  return allPermissionPaths().has(path);
}

/**
 * Walk the registry tree by dotted node path. Returns the node if found,
 * `undefined` otherwise. Used by dep-resolver + team.service for per-leaf
 * metadata lookups (`sodOwnerOnlyOnSelf`, `requires`).
 *
 * `nodePath` is the path TO the node, not including any action segment —
 * e.g. `'team.profile.bank'` returns the `bank` sub-feature node;
 * `'team.member'` returns the `member` feature node.
 */
export function findRegistryNode(nodePath: string): PermissionNode | undefined {
  const [modKey, ...rest] = nodePath.split('.');
  const mod = PERMISSION_REGISTRY.find((m) => m.module === modKey);
  if (!mod || rest.length === 0) return undefined;
  let cur: PermissionNode | undefined = mod.features.find((f) => f.key === rest[0]);
  for (const seg of rest.slice(1)) cur = cur?.children?.find((c) => c.key === seg);
  return cur;
}
