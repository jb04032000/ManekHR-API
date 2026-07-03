export enum AppModule {
  ATTENDANCE = 'attendance',
  TEAM = 'team',
  SALARY = 'salary',
  SHIFTS = 'shifts',
  ROLES = 'roles',
  SETTINGS = 'settings',
  /** @deprecated Use FINANCE module — bill capture moved to Finance.purchases. Kept for backward-compat with existing Plan/Subscription records. Remove in cleanup wave. */
  BILLS = 'bills',
  HOLIDAYS = 'holidays',
  MACHINES = 'machines',
  LOCATIONS = 'locations',
  RESOURCE_SCOPES = 'resource_scopes',
  FINANCE = 'finance',
  FINANCE_ADMIN = 'finance:admin',
  FINANCE_ACCOUNTANT = 'finance:accountant',
  REMINDERS = 'reminders',
  /** Promoted from Finance sub-feature — sellable as standalone module per audit decision (drift #6). */
  GST_COMPLIANCE = 'gst_compliance',
  /** Promoted from Finance sub-feature — sellable as standalone module per audit decision (drift #7). */
  INVENTORY = 'inventory',
  /** Promoted from Finance sub-feature — orphaned bom + manufacturing_voucher keys now properly registered (drift #9, drift #21). */
  MANUFACTURING = 'manufacturing',
  /** Promoted from Finance sub-feature — vertical play for textile/jewelry/processing customers (drift #8). */
  JOB_WORK = 'job_work',
  /** Promoted from Attendance sub-module — sellable Pro+ per audit decision. */
  REGULARIZATION = 'regularization',
  /** Promoted from Machines sub-module — Pro+ per audit decision. */
  DOWNTIME = 'downtime',
  /** Promoted from Machines sub-module — Enterprise per audit decision. */
  MAINTENANCE = 'maintenance',
  /** User-submitted product feedback (rating + free-text). Audit + analytics surface only — no subscription gate. */
  FEEDBACK = 'feedback',
  /** Identity-layer events (login/logout/register/password-reset/oauth). Tenant-agnostic — audit rows persist with `workspaceId: null`. */
  AUTH = 'auth',
  /** Workspace lifecycle + members + branding + export prefs + employee-code + kiosk. Phase 5 W5 (2026-05-09). */
  WORKSPACES = 'workspaces',
  /** Leave Management — leave-type catalogue, balances/ledger, accrual, requests, encashment. Leave epic L1 (2026-05-16). Tier-gated Growth+ (mirrors REGULARIZATION). */
  LEAVE = 'leave',
  /** ManekHR Connect — public-facing network / marketplace / jobs platform layered on the ERP. Connect epic Phase 0 (2026-05-18). Feature-flagged, not subscription-gated in Phases 0–2. All Connect sub-modules (profile/network/feed/marketplace/jobs/company/messaging) audit under this single entry in v1. */
  CONNECT = 'connect',
  /** ManekHR Connect ads + monetization (Boost Post first-party ad engine, wallet, billing). Foundation 2026-05-26. */
  ADS = 'ads',
  /** Admin-managed legal/policy pages (Terms + Privacy CMS). Platform-level content — audit rows persist with `workspaceId: null` (default 365-day retention). Added 2026-06-21. */
  LEGAL = 'legal',
  /** Subscription/plan lifecycle events surfaced for audit clarity (e.g. admin-side default-plan assignment + bulk backfill). Platform-level — audit rows persist with `workspaceId: null` (default 365-day retention). Added 2026-06-24. */
  SUBSCRIPTION = 'subscription',
  /** ManekHR Connect feed banner carousel — admin-curated promo banners shown in the Connect feed. Platform-level content — audit rows persist with `workspaceId: null` (default 365-day retention). Added 2026-07-03. */
  CONNECT_BANNERS = 'connect_banners',
}

export enum ModuleAction {
  VIEW = 'view',
  CREATE = 'create',
  ADD = 'add',
  EDIT = 'edit',
  DELETE = 'delete',
  MARK = 'mark',
  EXPORT = 'export',
  ADD_PAYMENT = 'add_payment',
  REMOVE = 'remove',
  MANAGE_DEVICES = 'manage_devices', // Phase B: attendance device management
  MANAGE_POLICIES = 'manage_policies', // Phase C: attendance policy management
  MANAGE_REGULARIZATIONS = 'manage_regularizations', // Phase D: attendance regularization workflow
  MANAGE_ANOMALIES = 'manage_anomalies', // Phase I: attendance anomaly feed and rule toggles
  ASSIGN = 'assign', // Machines: assign workers to machines
  MANAGE_PRODUCTION = 'manage_production', // Machines Phase 2: production output + downtime
  APPLY_LEAVE = 'apply_leave', // Leave epic: worker self-applies for leave (scope=self)
  APPROVE_LEAVE = 'approve_leave', // Leave epic: manager/HR approves or rejects leave requests
  MANAGE_LEAVE = 'manage_leave', // Leave epic: configure leave types/policies, adjust balances, run reports
  SENSITIVE_VIEW = 'sensitive_view', // Salary A3: view PII fields (bank, statutory IDs) on another member's salary record
  REQUEST_ADVANCE = 'request_advance', // Salary self-service: worker requests their OWN salary advance (scope=self). Modelled on APPLY_LEAVE — a dedicated self-service action decoupled from salary VIEW. Gated in advance-salary-request.controller.ts; toggled in Grant App Access (web PermissionGrid salary row).
  REQUEST_LOAN = 'request_loan', // Salary self-service: worker self-applies for their OWN 0% installment loan (scope=self). Modelled on REQUEST_ADVANCE — a dedicated self-service action decoupled from salary VIEW/EDIT. Creates a lightweight LoanRequest; the owner later approves it and the system materializes a real interest-free EmployerLoan via the existing LoanService (the EmployerLoan SoD guard is unchanged). AND-gated by payrollConfig.loanConfig.selfApplyEnabled. Gated in loan-request.controller.ts (Task 2); toggled in Grant App Access (web PermissionGrid salary row).
  DECLARE_TAX = 'declare_tax', // Salary self-service (OQ-S6): worker upserts their OWN IT/TDS tax declaration (scope=self). Dedicated self-service action decoupled from salary EDIT (Worker has no salary.edit), mirroring REQUEST_ADVANCE. The tax-declaration PUT route requires DECLARE_TAX@self; Worker holds declare_tax@self, HR holds declare_tax@all so HR/Owner keep the all-scoped upsert path. Gated in salary.controller.ts (upsertTaxDeclaration); toggled in Grant App Access (web PermissionGrid salary row).
  REVIEW_ADVANCE = 'review_advance', // Salary reporting-person review (Phase 3a): a member's reporting person (their TeamMember.reportsTo manager) SEES and VERIFIES their direct reports' advance requests. ADVISORY only — verify never changes request status or blocks the owner approve path. Visibility is a reportsTo-FILTERED read endpoint, NOT a new RBAC scope; this action reuses scope='self' + the reportsTo filter in advance-salary-request.controller.ts (for-my-reports + :requestId/verify). Mirrors REQUEST_ADVANCE; toggled in Grant App Access (web PermissionGrid salary row).
}
