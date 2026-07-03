/**
 * F-02 Sales module permission keys (D-16).
 *
 * These string constants are used as the `action` value in `RequirePermissions`
 * metadata for all finance/sales controller endpoints. The RBAC RolesGuard
 * maps `AppModule.FINANCE` + these action strings to role permission entries.
 *
 * See also: AppModule enum (src/common/enums/modules.enum.ts)
 */

export const FINANCE_SALES_PERMISSIONS = [
  'view_sales',
  'create_quotation',
  'create_sale_order',
  'create_proforma',
  'create_delivery_challan',
  'create_invoice',
  'edit_invoice',
  'cancel_invoice',
  'void_invoice',
  'print_invoice',
  'email_invoice',
  'whatsapp_invoice',
  'manage_recurring_invoice',
  'approve_voucher',
  'apply_late_fee',
  'generate_einvoice',
  'generate_ewaybill',
  'view_sales_dashboard',
  'convert_voucher',
] as const;

export type FinanceSalesPermission = typeof FINANCE_SALES_PERMISSIONS[number];

/**
 * F-11 Job-Work module permission keys (D-14).
 *
 * Used as `action` values in `@RequirePermissions` on JWI/JWO/ITC04 controller
 * endpoints. Wave 3 controllers (Plans 03 and 04) reference these strings.
 *
 * - manage_job_work_in  — create, post, and cancel Job-Work Inward Challans
 * - manage_job_work_out — create, post, and cancel Job-Work Outward Challans and Invoices
 * - generate_itc04      — access and export ITC-04 quarterly report
 *
 * All three are gated behind the 'job_work' subscription sub-feature
 * (@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'job_work' })).
 */
export const FINANCE_JOB_WORK_PERMISSIONS = [
  'manage_job_work_in',
  'manage_job_work_out',
  'generate_itc04',
] as const;

export type FinanceJobWorkPermission =
  typeof FINANCE_JOB_WORK_PERMISSIONS[number];

/**
 * F-15 (Phase 16) module permission keys (D-42).
 *
 * Used as `action` values in `@RequirePermissions` on Tally Export, FY Close,
 * and Customer Portal controller endpoints. All four default to workspace-OWNER
 * only; admin/finance roles must be explicitly granted via existing role matrix
 * UI.
 *
 * - tally_export         — generate and download Tally XML exports
 * - fy_close             — close a fiscal year (post closing + opening journals)
 * - fy_reopen            — reopen a closed fiscal year (requires MANAGE_WORKSPACE
 *                          AND fy_close simultaneously per D-42)
 * - party_portal_manage  — issue and revoke party portal access tokens
 *
 * All four are gated behind the existing 'finance_advanced' subscription
 * sub-feature (@RequireSubscription({ module: AppModule.FINANCE,
 * subFeature: 'finance_advanced' })) per D-43 — no new SKU.
 */
export const FINANCE_F15_PERMISSIONS = [
  'tally_export',
  'fy_close',
  'fy_reopen',
  'party_portal_manage',
] as const;

export type FinanceF15Permission = typeof FINANCE_F15_PERMISSIONS[number];

/**
 * F-16 (Phase 17) module permission keys (CONTEXT D-34, research Pitfall 10).
 *
 * Used as `action` values in `@RequirePermissions` on Party Intelligence
 * controller endpoints. All five default to workspace-OWNER only.
 *
 * - manage_party_intelligence  — read/write the intelligence sub-doc + settings
 * - set_blacklist              — toggle Party.intelligence.blacklisted (D-04)
 * - edit_rfm_thresholds        — workspace-level RFM tuning knobs (D-09)
 * - manage_greeting_templates  — birthday/anniversary template overrides (D-28)
 * - recheck_gstin              — manual GSTIN filing-status recheck (D-14)
 *
 * All five gated behind the existing 'finance_advanced' subscription
 * sub-feature per D-33 — no new SKU.
 */
export const FINANCE_F16_PERMISSIONS = [
  'manage_party_intelligence',
  'set_blacklist',
  'edit_rfm_thresholds',
  'manage_greeting_templates',
  'recheck_gstin',
] as const;

export type FinanceF16Permission = typeof FINANCE_F16_PERMISSIONS[number];

/**
 * Phase 21+ (Machines Phase 2) module permission keys (D-07).
 *
 * Used as `action` values in @RequirePermissions on production-logs,
 * downtime, and maintenance controller endpoints. Phase 21 wires only
 * the two production.* strings; phases 22 and 24 wire the rest.
 *
 * All gated behind subscription sub-features per D-08:
 *   machines.production.*    -> 'machines_production'
 *   machines.maintenance.*   -> 'machines_maintenance'
 *   machines.downtime.*      -> 'machines_downtime'
 *   dashboard.production.*   -> 'production_utilisation_dashboard'
 */
export const MACHINES_P2_PERMISSIONS = [
  'machines.production.log',
  'machines.production.view',
  'machines.maintenance.schedule',
  'machines.maintenance.log',
  'machines.downtime.log',
  'machines.downtime.view',
  'machines.downtime.reasons.manage',
  'dashboard.production.view',
] as const;

export type MachinesP2Permission = typeof MACHINES_P2_PERMISSIONS[number];

/**
 * Phase 23 — Piece-Rate Payroll module permission keys (D-10).
 *
 * Used as `action` value in @RequirePermissions on piece-rate preview +
 * config (PATCH/DELETE) endpoints. Owner-edit only by default; payroll
 * managers may be granted via role matrix.
 *
 * All gated behind subscription sub-feature 'piece_rate_payroll' (Machines
 * Phase 2 SKU per D-10).
 */
export const SALARY_PERMISSIONS = {
  MANAGE_PIECE_RATE: 'salary.piece_rate.manage',
} as const;

export type SalaryPermission =
  (typeof SALARY_PERMISSIONS)[keyof typeof SALARY_PERMISSIONS];
