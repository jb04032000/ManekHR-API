import { AppModule } from '../enums/modules.enum';
import { FeatureAccessLevel } from '../enums/feature-access.enum';

export interface SubFeatureDefinition {
  key: string;
  label: string;
  description?: string;

  supportsLimited: boolean;
}

export interface ModuleFeatureDefinition {
  module: AppModule;
  label: string;
  description?: string;
  subFeatures: SubFeatureDefinition[];
}

export const MODULE_FEATURES_REGISTRY: ModuleFeatureDefinition[] = [
  {
    module: AppModule.ATTENDANCE,
    label: 'Attendance',
    description: 'Track employee attendance and working hours',
    subFeatures: [
      {
        key: 'mark',
        label: 'Mark Attendance',
        description: 'Mark attendance for employees',
        supportsLimited: false,
      },
      {
        key: 'edit',
        label: 'Edit Attendance',
        description: 'Edit attendance records',
        supportsLimited: false,
      },
      {
        key: 'bulk_mark',
        label: 'Bulk Mark',
        description: 'Bulk mark attendance for multiple employees',
        supportsLimited: false,
      },
      {
        key: 'export_pdf',
        label: 'Export PDF',
        description: 'Export attendance data as PDF',
        supportsLimited: true,
      },
      {
        key: 'export_excel',
        label: 'Export Excel',
        description: 'Export attendance data as Excel',
        supportsLimited: true,
      },
      {
        key: 'auto_present',
        label: 'Auto-Present',
        description: 'Automatically mark attendance when shifts start',
        supportsLimited: false,
      },
      {
        key: 'advanced_filters',
        label: 'Advanced Filters',
        description: 'Filter attendance by shift and role',
        supportsLimited: false,
      },
      {
        key: 'per_employee_report',
        label: 'Per-Employee Report',
        description: 'Export individual employee attendance report',
        supportsLimited: false,
      },
      {
        key: 'date_range_export',
        label: 'Date Range Export',
        description: 'Export attendance across multiple months or a custom date range',
        supportsLimited: false,
      },
      {
        key: 'statutory_exports',
        label: 'Statutory Exports',
        description:
          'Generate India statutory compliance documents (MH Form T muster roll, OT register, PF/ESI wage register, LOP audit trail)',
        supportsLimited: false,
      },
      {
        key: 'analytics_charts',
        label: 'Analytics Charts',
        description: 'In-tile sparkline / trend / spike charts on attendance overview KPI cards',
        supportsLimited: false,
      },
      {
        key: 'defaulter_alerts',
        label: 'Defaulter Alerts',
        description:
          'Monthly automated alerts when employees fall below the attendance compliance threshold',
        supportsLimited: false,
      },
      {
        key: 'attendance_muster',
        label: 'Attendance Muster',
        description: 'Month-at-a-glance member × day muster register grid',
        supportsLimited: false,
      },
      {
        key: 'overtime_analytics',
        label: 'Overtime Analytics',
        description: 'Overtime worked by member, shift, and day, with cost estimation',
        supportsLimited: false,
      },
      {
        key: 'compliance_report',
        label: 'Compliance & Leaderboards',
        description: 'Attendance defaulters and late / absent leaderboards',
        supportsLimited: false,
      },
      {
        key: 'absence_patterns',
        label: 'Absence Patterns',
        description: 'Bradford-style absence scoring and weekday-cluster detection',
        supportsLimited: false,
      },
      {
        key: 'anomaly_detection',
        label: 'Anomaly Detection',
        description:
          'Flag suspicious attendance events — unknown devices, rapid duplicates, missed streaks, off-shift punches, time-travel',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.TEAM,
    label: 'Team',
    description: 'Manage team members and roles',
    subFeatures: [
      {
        key: 'add_member',
        label: 'Add Member',
        description: 'Add new team member',
        supportsLimited: false,
      },
      {
        key: 'edit_member',
        label: 'Edit Member',
        description: 'Edit team member details',
        supportsLimited: false,
      },
      {
        key: 'remove_member',
        label: 'Remove Member',
        description: 'Archive (soft-delete) a team member',
        supportsLimited: false,
      },
      {
        key: 'bulk_import',
        label: 'Bulk Import',
        description: 'Import multiple members at once',
        supportsLimited: false,
      },
      {
        key: 'grant_app_access',
        label: 'Grant App Access',
        description: 'Grant mobile app login access to a member',
        supportsLimited: false,
      },
      {
        key: 'bulk_deactivate',
        label: 'Bulk Deactivate',
        description: 'Bulk deactivate members',
        supportsLimited: false,
      },
      {
        key: 'bulk_restore',
        label: 'Bulk Restore',
        description: 'Bulk restore archived members',
        supportsLimited: false,
      },
      {
        key: 'bulk_archive',
        label: 'Bulk Archive',
        description: 'Bulk archive members',
        supportsLimited: false,
      },
      {
        key: 'restore_member',
        label: 'Restore Member',
        description: 'Restore archived member',
        supportsLimited: false,
      },
      {
        key: 'offboard_member',
        label: 'Offboard Member',
        description: 'Offboard a team member',
        supportsLimited: false,
      },
      {
        key: 'export_team',
        label: 'Export Team',
        description: 'Export team data',
        supportsLimited: true,
      },
      {
        key: 'designation_filter',
        label: 'Designation Filter',
        description: 'Filter team members by designation using filter chips',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.SALARY,
    label: 'Salary',
    description: 'Manage payroll and salary payments',
    subFeatures: [
      {
        key: 'generate_payroll',
        label: 'Generate Payroll',
        description: 'Generate monthly payroll',
        supportsLimited: false,
      },
      {
        key: 'record_payment',
        label: 'Record Payment',
        description: 'Record salary payment',
        supportsLimited: false,
      },
      {
        key: 'edit_salary',
        label: 'Edit Salary',
        description: 'Edit salary records',
        supportsLimited: false,
      },
      {
        key: 'salary_adjustments_view',
        label: 'View Adjustments',
        description: 'View the salary adjustment register',
        supportsLimited: false,
      },
      {
        key: 'salary_adjustments_create',
        label: 'Create Adjustments',
        description: 'Create salary adjustment entries',
        supportsLimited: false,
      },
      {
        key: 'salary_adjustments_reverse',
        label: 'Reverse Adjustments',
        description: 'Reverse posted salary adjustment entries',
        supportsLimited: false,
      },
      {
        key: 'salary_adjustments_edit_note',
        label: 'Edit Adjustment Notes',
        description: 'Edit salary adjustment metadata such as notes later',
        supportsLimited: false,
      },
      {
        key: 'salary_adjustments_view_audit',
        label: 'View Adjustment Audit',
        description: 'View audit logs for salary adjustments',
        supportsLimited: false,
      },
      {
        key: 'export_pdf',
        label: 'Export PDF',
        description: 'Export salary slip as PDF',
        supportsLimited: true,
      },
      {
        key: 'export_excel',
        label: 'Export Excel',
        description: 'Export salary data as Excel',
        supportsLimited: true,
      },
      {
        key: 'advance_payments',
        label: 'Advance Payments',
        description: 'Handle advance payment requests',
        supportsLimited: false,
      },
      {
        key: 'split_payments',
        label: 'Split Payments',
        description: 'Split payments across multiple methods',
        supportsLimited: false,
      },
      {
        key: 'bulk_payments',
        label: 'Bulk Payments',
        description: 'Record payments for multiple employees at once',
        supportsLimited: false,
      },
      {
        key: 'commission_tracking',
        label: 'Commission Tracking',
        description: 'Track commission amounts with salary payments',
        supportsLimited: false,
      },
      {
        key: 'salary_components',
        label: 'Salary Components / CTC',
        description: 'Define CTC breakdown with salary component templates',
        supportsLimited: false,
      },
      {
        key: 'payslip_generation',
        label: 'Payslip Generation',
        description: 'Generate and download salary payslips as PDF',
        supportsLimited: true,
      },
      {
        key: 'statutory_compliance',
        label: 'Statutory Compliance Settings',
        description: 'Manage PF, ESI, PT, and TDS statutory payroll settings',
        supportsLimited: false,
      },
      {
        key: 'statutory_tds',
        label: 'Tax Declarations / TDS',
        description: 'Manage tax declarations and monthly TDS projections',
        supportsLimited: false,
      },
      {
        key: 'compliance_exports',
        label: 'Compliance Exports',
        description: 'Export PF ECR, ESI challan, and bank disbursement files',
        supportsLimited: false,
      },
      {
        key: 'form16_generation',
        label: 'Form 16 Generation',
        description: 'Generate salary TDS certificates for a financial year',
        supportsLimited: false,
      },
      {
        key: 'payslip_email',
        label: 'Payslip Email Delivery',
        description: 'Send generated payslips to employees by email',
        supportsLimited: false,
      },
      {
        key: 'gratuity_tracking',
        label: 'Gratuity Tracking',
        description: 'View gratuity liability tracking and long-service summaries',
        supportsLimited: false,
      },
      {
        key: 'lwf_tracking',
        label: 'Labour Welfare Fund',
        description: 'Configure and manage Labour Welfare Fund deductions by state',
        supportsLimited: false,
      },
      {
        key: 'tds_management',
        label: 'TDS Challan Management',
        description: 'Record TDS challans, monthly liability, and quarterly summaries',
        supportsLimited: false,
      },
      {
        key: 'fnf_settlement',
        label: 'Full & Final Settlement',
        description: 'Initiate, review, and finalise full and final settlement statements',
        supportsLimited: false,
      },
      {
        key: 'salary_increments',
        label: 'Salary Increments',
        description: 'Manage scheduled salary increments and revisions',
        supportsLimited: false,
      },
      {
        key: 'reverse_payment',
        label: 'Reverse Payment',
        description: 'Reverse recorded salary payments',
        supportsLimited: false,
      },
      // 2026-07-02 gating-gap batch: these three keys are enforced by
      // @RequireSubscription on the salary + loan-request controllers but were
      // missing from this catalog, so validateModuleAccess rejected admin custom-plan
      // payloads carrying them and the web editor rendered no toggle -> permanent 403.
      // Tier defaults (TIER_SUBFEATURE_DEFAULTS below) mirror the sibling paid-salary
      // cluster (advance_payments/split_payments/bulk_payments/commission_tracking):
      // LOCKED on free, FULL on every paid tier. Keep in sync with the web registry
      // (web/lib/constants/feature-access.registry.ts) SALARY block.
      {
        // Enforced by loan-request.controller.ts (class-level) + salary.controller.ts
        // employer-loan routes @RequireSubscription({ module: SALARY, subFeature:
        // 'loan_management' }).
        key: 'loan_management',
        label: 'Loan Management',
        description: 'Employer loans and 0% employee installment loan requests',
        supportsLimited: false,
      },
      {
        // Enforced by salary.controller.ts bonus routes @RequireSubscription({ module:
        // SALARY, subFeature: 'bonus_tracking' }).
        key: 'bonus_tracking',
        label: 'Bonus Tracking',
        description: 'Record and track employee bonus entries alongside payroll',
        supportsLimited: false,
      },
      {
        // Enforced by salary.controller.ts daily-wage routes @RequireSubscription({
        // module: SALARY, subFeature: 'daily_wage_ledger' }).
        key: 'daily_wage_ledger',
        label: 'Daily Wage Ledger',
        description: 'Maintain a daily-wage earnings ledger for casual / daily workers',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.SHIFTS,
    label: 'Shifts',
    description: 'Manage work shifts and scheduling',
    subFeatures: [
      {
        key: 'create_shift',
        label: 'Create Shift',
        description: 'Create new shift',
        supportsLimited: false,
      },
      {
        key: 'edit_shift',
        label: 'Edit Shift',
        description: 'Edit shift details',
        supportsLimited: false,
      },
      {
        key: 'delete_shift',
        label: 'Delete Shift',
        description: 'Delete shift',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.HOLIDAYS,
    label: 'Holidays',
    description: 'Manage workspace holidays and observances',
    subFeatures: [
      {
        key: 'create_holiday',
        label: 'Create Holiday',
        description: 'Create new holiday',
        supportsLimited: false,
      },
      {
        key: 'edit_holiday',
        label: 'Edit Holiday',
        description: 'Edit holiday details',
        supportsLimited: false,
      },
      {
        key: 'delete_holiday',
        label: 'Delete Holiday',
        description: 'Delete holiday',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.ROLES,
    label: 'Roles',
    description: 'Manage custom roles and permissions',
    subFeatures: [
      {
        key: 'create_role',
        label: 'Create Role',
        description: 'Create custom role',
        supportsLimited: false,
      },
      {
        key: 'edit_role',
        label: 'Edit Role',
        description: 'Edit role permissions',
        supportsLimited: false,
      },
      {
        key: 'delete_role',
        label: 'Delete Role',
        description: 'Delete role',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.FINANCE,
    label: 'Finance',
    description:
      'GST-compliant invoicing, bookkeeping, party ledger, banking, fixed assets, and reports',
    subFeatures: [
      // Wave 7 — bare legacy aliases (`finance_basic`, `finance_advanced`,
      // `gst_compliance`, `job_work`, `bom`, `manufacturing_voucher`,
      // `party_intelligence`) dropped after Wave 6 re-key migrated all
      // active decorators to canonical taxonomy. Per-feature legacy keys
      // still consumed by UI (`finance_accountant_invite`,
      // `party_intelligence_*`) preserved.
      {
        key: 'finance_accountant_invite',
        label: 'Accountant Invite',
        description: 'Invite a CA / accountant to your books with read-only or full access',
        supportsLimited: false,
      },
      // 2026-05-15 — these three keys are still emitted by the web
      // feature-access registry (admin custom-plan payload source) so the
      // catalog must recognise them. `finance_gstin_byok` is a live
      // feature; `finance_vouchers` + `party_intelligence` are coarse
      // legacy gates kept for existing UI consumers (settings/finance,
      // FINANCE_VOUCHERS_FEATURE_KEY). Mirrored from
      // crewroster-web/lib/constants/feature-access.registry.ts.
      {
        key: 'finance_gstin_byok',
        label: 'GSTIN BYOK',
        description: 'Use your own GSTIN provider API key (consumed by settings/finance page)',
        supportsLimited: false,
      },
      {
        key: 'finance_vouchers',
        label: 'Finance Vouchers (legacy)',
        description:
          'Coarse vouchers gate — superseded by accounting_journal_entries / contra_entries / cash_registers',
        supportsLimited: false,
      },
      {
        key: 'party_intelligence',
        label: 'Party Intelligence (legacy)',
        description: 'Coarse party-intelligence gate',
        supportsLimited: false,
      },
      {
        key: 'party_intelligence_rfm',
        label: 'Party RFM Analytics',
        description: 'Recency / Frequency / Monetary analytics per party',
        supportsLimited: false,
      },
      {
        key: 'party_intelligence_gstin_monitor',
        label: 'GSTIN Monitor',
        description: 'Monitor party GSTIN status changes',
        supportsLimited: false,
      },
      {
        key: 'party_intelligence_timeline',
        label: 'Party Event Timeline',
        description: 'Single timeline of every invoice / payment / communication / note per party',
        supportsLimited: false,
      },
      {
        key: 'party_intelligence_pnl',
        label: 'Party P&L',
        description: 'Per-party profit margin analysis',
        supportsLimited: false,
      },
      {
        key: 'party_intelligence_greetings',
        label: 'Party Greetings',
        description: 'Greeting templates and blacklist controls',
        supportsLimited: false,
      },
      // ── Sales ──
      {
        key: 'sales_invoicing',
        label: 'Sales Invoicing',
        description: 'Full sales invoice lifecycle — draft, post, approve, cancel, clone, send',
        supportsLimited: false,
      },
      {
        key: 'sales_orders',
        label: 'Sales Orders',
        description: 'Convert quotes to confirmed sales orders',
        supportsLimited: false,
      },
      {
        key: 'sales_quotations',
        label: 'Sales Quotations',
        description: 'Send professional quotations and convert to sale order',
        supportsLimited: false,
      },
      {
        key: 'sales_proforma',
        label: 'Proforma Invoices',
        description: 'Issue pre-sale proforma invoices',
        supportsLimited: false,
      },
      {
        key: 'sales_delivery_challans',
        label: 'Delivery Challans',
        description: 'Move goods to customer with valid GST challans',
        supportsLimited: false,
      },
      {
        key: 'sales_recurring_billing',
        label: 'Recurring Invoices',
        description: 'Auto-generate invoices on a schedule (rent, AMC, retainer)',
        supportsLimited: false,
      },
      {
        key: 'sales_credit_debit_notes',
        label: 'Credit & Debit Notes',
        description: 'Issue / receive returns and adjustments with ITC reversal',
        supportsLimited: false,
      },
      // ── Purchases ──
      {
        key: 'purchases_invoicing',
        label: 'Purchase Bills',
        description: 'Record vendor bills with GST and ITC tracking',
        supportsLimited: false,
      },
      {
        key: 'purchases_orders',
        label: 'Purchase Orders',
        description: 'Send POs to vendors and track delivery against them',
        supportsLimited: false,
      },
      {
        key: 'purchases_grn',
        label: 'Goods Receipt (GRN)',
        description: 'Confirm goods received against PO; trigger ITC',
        supportsLimited: false,
      },
      {
        key: 'purchases_grn_returns',
        label: 'GRN Returns',
        description: 'Record purchase returns from GRN',
        supportsLimited: false,
      },
      {
        key: 'purchases_expenses',
        label: 'Expense Vouchers',
        description: 'Record cash / bank expenses (rent, electricity, salaries)',
        supportsLimited: false,
      },
      {
        key: 'purchases_ocr',
        label: 'Vendor Bill OCR',
        description: 'Snap a vendor bill — AI reads everything into the form',
        supportsLimited: false,
      },
      {
        key: 'purchases_payment_outward',
        label: 'Payment Outward',
        description: 'Pay vendors via cheque / NEFT / UPI / mixed modes',
        supportsLimited: false,
      },
      {
        key: 'purchases_capital_goods_itc',
        label: 'Capital Goods ITC',
        description: 'Track ITC on capital goods over multi-year schedule',
        supportsLimited: false,
      },
      {
        key: 'purchases_payables',
        label: 'Payables Listing',
        description: 'View aged payables across vendors',
        supportsLimited: false,
      },
      // ── Payments ──
      {
        key: 'payments_payment_in',
        label: 'Payment Receipts',
        description: 'Record customer payments against invoices',
        supportsLimited: false,
      },
      {
        key: 'payments_party_ledger',
        label: 'Party Ledger',
        description: 'Per-party transaction ledger view',
        supportsLimited: false,
      },
      // ── Banking ──
      {
        key: 'banking_bank_accounts',
        label: 'Bank Accounts & Reconciliation',
        description: 'Multiple bank accounts with statement reconciliation and running balance',
        supportsLimited: false,
      },
      {
        key: 'banking_cheques',
        label: 'Cheque Register',
        description: 'Track every issued / received cheque through clearing',
        supportsLimited: false,
      },
      {
        key: 'banking_loan_accounts',
        label: 'Loan Accounts & EMI',
        description: 'Loan ledger with auto-EMI posting and amortisation',
        supportsLimited: false,
      },
      // ── Accounting ──
      {
        key: 'accounting_journal_entries',
        label: 'Journal Vouchers',
        description: 'Manual debit / credit entries for accountants',
        supportsLimited: false,
      },
      {
        key: 'accounting_contra_entries',
        label: 'Contra Entries',
        description: 'Bank-to-bank, cash-to-bank inter-account transfers',
        supportsLimited: false,
      },
      {
        key: 'accounting_coa',
        label: 'Chart of Accounts',
        description: 'Standard + custom ledger heads',
        supportsLimited: false,
      },
      {
        key: 'accounting_fiscal_years',
        label: 'Fiscal Years',
        description: 'Multi-year books with formal year-end close',
        supportsLimited: false,
      },
      {
        key: 'accounting_voucher_series',
        label: 'Voucher Series',
        description: 'Configure number sequences (INV-001, PO-001…)',
        supportsLimited: false,
      },
      {
        key: 'accounting_items_master',
        label: 'Item Master',
        description: 'Items + services with HSN/SAC, GST rates, pricing tiers',
        supportsLimited: false,
      },
      {
        key: 'accounting_setup_checklist',
        label: 'Setup Checklist',
        description: 'Onboarding guide for new firms',
        supportsLimited: false,
      },
      {
        key: 'accounting_recycle_bin',
        label: 'Recycle Bin',
        description: 'Soft-delete recovery + permanent purge',
        supportsLimited: false,
      },
      {
        key: 'accounting_tally_export',
        label: 'Tally XML Export',
        description: 'Export ledger to Tally XML for legacy ERP bridges',
        supportsLimited: false,
      },
      {
        key: 'accounting_cash_registers',
        label: 'Cash Registers',
        description: 'POS-style daily cash reconciliation',
        supportsLimited: false,
      },
      // ── Fixed Assets ──
      {
        key: 'fixed_assets_categories',
        label: 'Asset Categories',
        description: 'Categorise assets — vehicles, machinery, IT, building',
        supportsLimited: false,
      },
      {
        key: 'fixed_assets_register',
        label: 'Asset Register',
        description: 'Maintain a complete fixed-asset register with depreciation',
        supportsLimited: false,
      },
      {
        key: 'fixed_assets_depreciation',
        label: 'Depreciation',
        description: 'Auto-calc straight-line / WDV depreciation; post to ledger',
        supportsLimited: false,
      },
      {
        key: 'fixed_assets_disposal',
        label: 'Asset Disposal',
        description: 'Record sale / scrap of assets with gain / loss to ledger',
        supportsLimited: false,
      },
      {
        key: 'fixed_assets_linking',
        label: 'Asset Linking',
        description: 'Link assets to projects, departments, cost centers',
        supportsLimited: false,
      },
      {
        key: 'fixed_assets_reports',
        label: 'Fixed Asset Reports',
        description: 'Asset register, depreciation schedule, block summary',
        supportsLimited: false,
      },
      // ── Reports & Parties ──
      {
        key: 'reports_financial',
        label: 'Financial Reports',
        description: 'Trial balance, P&L, balance sheet, cash flow, GST summaries',
        supportsLimited: false,
      },
      {
        key: 'parties_master',
        label: 'Parties (Customers / Vendors)',
        description: 'Customers and vendors with contacts, GSTIN, addresses',
        supportsLimited: false,
      },
      {
        key: 'party_portal_access',
        label: 'Party Self-Serve Portal',
        description: 'Send customers a self-serve link — they see invoices, ledger, pay online',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.REMINDERS,
    label: 'Reminders',
    description:
      'Multi-channel collections — auto-nag overdue customers across in-app, email, SMS, WhatsApp, push',
    subFeatures: [
      {
        key: 'reminder_rules_view',
        label: 'View Rules',
        description: 'See active reminder rules + audit trail',
        supportsLimited: false,
      },
      {
        key: 'reminder_rules_manage',
        label: 'Manage Rules',
        description: 'Define payment-reminder rules with escalation levels',
        supportsLimited: false,
      },
      {
        key: 'reminder_settings_manage',
        label: 'Reminder Settings',
        description: 'Configure firm-level frequency caps, opt-outs, channel defaults',
        supportsLimited: false,
      },
      {
        key: 'reminder_templates_customize',
        label: 'Custom Templates',
        description: 'Workspace / firm-specific email + SMS templates with variable substitution',
        supportsLimited: false,
      },
      {
        key: 'reminder_channel_in_app',
        label: 'In-App Channel',
        description: 'In-app dashboard reminder feed',
        supportsLimited: false,
      },
      {
        key: 'reminder_channel_email',
        label: 'Email Channel',
        description: 'Send reminder emails via workspace SMTP or relay',
        supportsLimited: false,
      },
      {
        key: 'reminder_channel_sms',
        label: 'SMS Channel',
        description: 'Send TRAI-compliant DLT-templated SMS reminders via MSG91 (credit-pack)',
        supportsLimited: false,
      },
      {
        key: 'reminder_channel_whatsapp',
        label: 'WhatsApp Channel',
        description: 'Send WhatsApp reminders via AiSensy BSP (credit-pack)',
        supportsLimited: false,
      },
      {
        key: 'reminder_channel_push',
        label: 'Push Notification Channel',
        description: 'Send mobile push notifications via Firebase',
        supportsLimited: false,
      },
      {
        key: 'reminder_call_todo_view',
        label: 'View Call Todos',
        description: 'View call-back todo list per customer',
        supportsLimited: false,
      },
      {
        key: 'reminder_call_todo_manage',
        label: 'Manage Call Todos',
        description: 'Manual call-back todos with priority, snooze, completion tracking',
        supportsLimited: false,
      },
      {
        key: 'reminder_auto_escalation',
        label: 'Auto Escalation',
        description: 'Level-3 rules auto-create CallTodo for 21+ day overdue invoices',
        supportsLimited: false,
      },
      {
        key: 'reminder_audit_log',
        label: 'Reminder Audit Log',
        description: 'Full dispatch history with status, recipient (masked), errors',
        supportsLimited: false,
      },
      {
        key: 'reminder_dispatcher_run',
        label: 'Dispatcher Trigger',
        description: 'Manually run / inspect the daily reminder dispatcher cron',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.SETTINGS,
    label: 'Settings',
    description: 'Configure workspace settings',
    subFeatures: [
      {
        key: 'edit_settings',
        label: 'Edit Settings',
        description: 'Edit workspace settings',
        supportsLimited: false,
      },
      {
        key: 'workspace_branding',
        label: 'Workspace Branding',
        description: 'Upload custom logos and footer details for PDF exports',
        supportsLimited: false,
      },
      {
        key: 'pdf_branding',
        label: 'PDF Branding',
        description: 'Use custom branding in exported PDFs across all modules',
        supportsLimited: false,
      },
    ],
  },
  // ── Promoted top-level modules (2026-05-15) ───────────────────────────
  // These modules were promoted from Finance sub-features / Attendance &
  // Machines sub-modules into standalone `AppModule` enum entries (drift
  // #6-#9 + Wave-2 audit) but were never added to this feature catalog —
  // so `validateModuleAccess` (subscriptions/dto/subscription.dto.ts)
  // rejected admin custom-plan assignments that included them ("Unknown
  // module 'machines'" etc). Definitions mirrored verbatim from the web
  // registry `crewroster-web/lib/constants/feature-access.registry.ts`
  // (the authoritative catalog the admin panel builds its payload from)
  // so the two stay in lockstep.
  {
    module: AppModule.MACHINES,
    label: 'Machines',
    description: 'Manage operational machines and worker assignments',
    subFeatures: [
      {
        key: 'machines_basic',
        label: 'Machine CRUD',
        description: 'Create, edit, and retire machines',
        supportsLimited: false,
      },
      {
        key: 'machines_assignments',
        label: 'Machine Assignments',
        description: 'Assign workers to machines for specific shifts',
        supportsLimited: false,
      },
      {
        // Gates production log CRUD + bulk-entry (Phase 21). Key was already
        // known to the boot migration (machines-plan-migration.service.ts) but
        // missing from THIS catalog, so validateModuleAccess rejected admin
        // custom-plan payloads carrying it and the web editor rendered no toggle.
        // Keep in sync with the web registry
        // (web/lib/constants/feature-access.registry.ts) MACHINES block.
        key: 'machines_production',
        label: 'Bulk Production Entry',
        description: 'Record production log CRUD and bulk shift-output entry',
        supportsLimited: false,
      },
      {
        // Key was known to the boot migration (MACHINES_P2_SUBFEATURES) and gated
        // by the maintenance controller (@RequireSubscription subFeature:
        // 'machines_maintenance'), but missing from THIS catalog — so
        // validateModuleAccess rejected admin custom-plan payloads carrying it and
        // GET maintenance/due 403'd. Keep in sync with the web registry
        // (web/lib/constants/feature-access.registry.ts) MACHINES block.
        key: 'machines_maintenance',
        label: 'Machine Maintenance',
        description: 'Schedule preventive maintenance, log work orders, and track due dates',
        supportsLimited: false,
      },
      {
        // Gated by the downtime + downtime-reasons controllers
        // (@RequireSubscription subFeature: 'machines_downtime'); same catalog
        // gap as machines_maintenance. Keep in sync with the web registry
        // (web/lib/constants/feature-access.registry.ts) MACHINES block.
        key: 'machines_downtime',
        label: 'Downtime Tracking',
        description: 'Record machine downtime with categorised reasons and duration',
        supportsLimited: false,
      },
      {
        key: 'production_utilisation_dashboard',
        label: 'Production Utilisation Dashboard',
        description:
          'Read-only KPI/trend/heatmap dashboard over production output, downtime, and uptime',
        supportsLimited: false,
      },
      {
        // Gates piece-rate payroll config + preview (Phase 23, D-10). Enforced by
        // salary.controller.ts (piece-rate/preview + set/clear config) and
        // team.controller.ts via @RequireSubscription({ module: MACHINES,
        // subFeature: 'piece_rate_payroll' }); FE gate
        // useFeatureAccess('machines','piece_rate_payroll') on the member piece-rate
        // tab. Declared in MACHINES_P2_SUBFEATURES but was missing from THIS catalog,
        // so validateModuleAccess rejected admin custom-plan payloads carrying it and
        // the editor rendered no toggle. Like the machines trio, MACHINES is omitted
        // from buildModuleAccess (boot-seeded subFeatures:[] -> grandfather FULL), so
        // this is admin-grantable only with no tier auto-grant. Keep in sync with the
        // web registry (web/lib/constants/feature-access.registry.ts) MACHINES block.
        key: 'piece_rate_payroll',
        label: 'Piece-Rate Payroll',
        description: 'Configure and preview piece-rate earnings for workers by machine output',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.LOCATIONS,
    label: 'Locations',
    description: 'Manage operational sites where machines physically run',
    subFeatures: [
      {
        key: 'location_manage',
        label: 'Manage Locations',
        description: 'Create, edit, and remove operational locations',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.RESOURCE_SCOPES,
    label: 'Resource Scopes',
    description:
      'Row-level access scoping — limit users to specific machines and locations regardless of RBAC role',
    subFeatures: [
      {
        key: 'resource_scope_manage',
        label: 'Manage Resource Scopes',
        description: 'Create and edit per-user machine/location scope assignments',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.INVENTORY,
    label: 'Inventory',
    description:
      'Stock management — godowns, lots, batches, serials, transfers, wastage, and samples/consignment',
    subFeatures: [
      {
        key: 'items_master',
        label: 'Items Master',
        description: 'Item + service master with HSN/SAC, GST rates, pricing tiers',
        supportsLimited: false,
      },
      {
        key: 'stock_summary',
        label: 'Stock Summary',
        description: 'Real-time stock per item / per godown',
        supportsLimited: false,
      },
      {
        key: 'stock_movements_view',
        label: 'Stock Movements (View)',
        description: 'Read-only ledger of every stock in/out/transfer',
        supportsLimited: false,
      },
      {
        key: 'godowns',
        label: 'Multi-Godown',
        description: 'Create and manage multiple warehouse/location godowns per firm',
        supportsLimited: false,
      },
      {
        key: 'lots',
        label: 'Lot Tracking',
        description: 'Group items into manufacturing lots for traceability',
        supportsLimited: false,
      },
      {
        key: 'batches',
        label: 'Batch Tracking',
        description: 'Track expiry-managed batches for pharma, food, perishables',
        supportsLimited: false,
      },
      {
        key: 'serial_tracking',
        label: 'Serial Number Tracking',
        description: 'Trace each unit by serial — purchase → sale → return/scrap with audit trail',
        supportsLimited: false,
      },
      {
        key: 'samples',
        label: 'Samples & Consignment',
        description: 'Dispatch samples / consignment without billing; track returns',
        supportsLimited: false,
      },
      {
        key: 'stock_transfers',
        label: 'Stock Transfers',
        description: 'Move stock between godowns with audit trail; lock to prevent double-posting',
        supportsLimited: false,
      },
      {
        key: 'wastage',
        label: 'Wastage / Scrap',
        description: 'Log scrap/damage/shrinkage with reasons; auditable cost tracking',
        supportsLimited: false,
      },
      {
        key: 'barcode',
        label: 'Barcode Scan',
        description: 'Generate barcode labels; scan from any phone camera',
        supportsLimited: false,
      },
      {
        key: 'cess_rules',
        label: 'Cess Rules',
        description: 'Per-item cess configuration for tobacco, luxury, environment levies',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.GST_COMPLIANCE,
    label: 'GST Compliance',
    description:
      'GST filing suite — GSTR-1, GSTR-3B, e-Invoice, e-Way Bills, Verify-My-Data, ITC-04',
    subFeatures: [
      {
        key: 'gstin_lookup',
        label: 'GSTIN Lookup',
        description: 'Validate any GSTIN against GSTN portal in real time',
        supportsLimited: false,
      },
      {
        key: 'einvoice_generation',
        label: 'e-Invoice (IRN)',
        description: 'Auto-generate IRN + signed e-Invoice QR for B2B sales',
        supportsLimited: false,
      },
      {
        key: 'ewaybill_generation',
        label: 'e-Way Bill',
        description:
          'Generate e-way bills above ₹50k threshold; extend within 8h, cancel within 24h',
        supportsLimited: false,
      },
      {
        key: 'verify_my_data',
        label: 'Verify-My-Data',
        description: 'Pre-filing scan — catches missing GSTINs, mismatched HSN, ITC errors',
        supportsLimited: false,
      },
      {
        key: 'gstr1_filing',
        label: 'GSTR-1 Filing',
        description: 'Generate, validate, and export GSTR-1 (sales return) for portal upload',
        supportsLimited: false,
      },
      {
        key: 'gstr3b_filing',
        label: 'GSTR-3B Filing',
        description: 'Auto-computed GSTR-3B with manual cell overrides + GSTN-compliant JSON',
        supportsLimited: false,
      },
      {
        key: 'itc04_filing',
        label: 'ITC-04 (Job Work)',
        description: 'Quarterly ITC-04 statement for job-work goods movement',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.MANUFACTURING,
    label: 'Manufacturing / BOM',
    description:
      'Production accounting — BOM design, work-order lifecycle, automatic WIP/FG/COGS posting',
    subFeatures: [
      {
        key: 'bom_crud',
        label: 'BOM Design',
        description: 'Design multi-level BOMs — components, alternates, scrap rates',
        supportsLimited: false,
      },
      {
        key: 'bom_explosion',
        label: 'BOM Explosion',
        description: 'Auto-explode BOMs to leaf components for procurement planning',
        supportsLimited: false,
      },
      {
        key: 'bom_costing',
        label: 'Standard Costing',
        description: 'Compute standard cost from live component prices; sync with inventory',
        supportsLimited: false,
      },
      {
        key: 'manufacturing_voucher',
        label: 'Manufacturing Vouchers',
        description: 'Manufacturing journal entries — WIP, FG, COGS in one workflow',
        supportsLimited: false,
      },
      {
        key: 'manufacturing_voucher_lifecycle',
        label: 'Production Lifecycle',
        description:
          'Order-to-completion lifecycle — draft → issue materials → complete → variance posting',
        supportsLimited: false,
      },
      {
        key: 'manufacturing_voucher_register',
        label: 'Production Register',
        description: 'Production register with yields, material totals, bottleneck reports',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.JOB_WORK,
    label: 'Job Work',
    description:
      'Job-work cycle — outward/inward challans, processor invoicing, lot tracking, statutory ITC-04',
    subFeatures: [
      {
        key: 'outward',
        label: 'Outward Challan',
        description: 'Send goods to job worker with valid challan and timer for return',
        supportsLimited: false,
      },
      {
        key: 'inward',
        label: 'Inward Challan',
        description: 'Receive processed goods; auto-match against outward challan',
        supportsLimited: false,
      },
      {
        key: 'invoicing',
        label: 'Job Work Invoice',
        description: 'Pay job worker; ITC on service GST',
        supportsLimited: false,
      },
      {
        key: 'lots',
        label: 'Lot Tracking',
        description: 'Group job-work goods into lots for traceability',
        supportsLimited: false,
      },
      {
        key: 'itc04',
        label: 'ITC-04 Report',
        description: 'Auto-generate ITC-04 quarterly statement for GST filing',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.REGULARIZATION,
    label: 'Attendance Regularization',
    description:
      'Approval workflow for attendance corrections — request, review, approve/reject with full audit trail',
    subFeatures: [
      {
        key: 'request',
        label: 'Request Regularization',
        description: 'Employees request attendance corrections from the app',
        supportsLimited: false,
      },
      {
        key: 'approve',
        label: 'Approve Request',
        description: 'Managers approve correction requests in one tap',
        supportsLimited: false,
      },
      {
        key: 'reject',
        label: 'Reject Request',
        description: 'Managers reject correction requests with reason',
        supportsLimited: false,
      },
      {
        key: 'view_audit',
        label: 'View Audit Trail',
        description: 'See full history of every regularization with actor + reason',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.DOWNTIME,
    label: 'Machine Downtime',
    description:
      'Track machine downtime — power cuts, breakdowns, changeovers, with categorised reasons',
    subFeatures: [
      {
        key: 'view',
        label: 'View Downtime',
        description: 'View downtime entries and categorised reasons per machine',
        supportsLimited: false,
      },
      {
        key: 'log',
        label: 'Log Downtime',
        description: 'Record machine downtime with category and duration',
        supportsLimited: false,
      },
      {
        key: 'manage_reasons',
        label: 'Manage Downtime Reasons',
        description: 'Define custom downtime reasons for your operations',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.MAINTENANCE,
    label: 'Preventive Maintenance',
    description:
      'Schedule preventive maintenance, log work orders, track MTBF — for industrial customers',
    subFeatures: [
      {
        key: 'view',
        label: 'View Maintenance',
        description: 'View scheduled maintenance + completed work orders',
        supportsLimited: false,
      },
      {
        key: 'schedule',
        label: 'Schedule Maintenance',
        description: 'Schedule preventive maintenance plans per machine',
        supportsLimited: false,
      },
      {
        key: 'log',
        label: 'Log Work Order',
        description: 'Log maintenance work orders with parts, labour, downtime',
        supportsLimited: false,
      },
      {
        key: 'manage',
        label: 'Manage Plans',
        description: 'Create and update maintenance plans + intervals',
        supportsLimited: false,
      },
    ],
  },
  {
    module: AppModule.LEAVE,
    label: 'Leave Management',
    description:
      'Configurable leave types, balances + accrual, multi-day requests with approval, comp-off and encashment',
    subFeatures: [
      {
        key: 'apply',
        label: 'Apply for Leave',
        description: 'Employees apply for leave from the app and track approval status',
        supportsLimited: false,
      },
      {
        key: 'approve',
        label: 'Approve Leave',
        description: 'Managers and HR approve or reject leave requests with full audit trail',
        supportsLimited: false,
      },
      {
        key: 'view_balance',
        label: 'View Leave Balance',
        description: 'See per-type leave balances, accrual, and request history',
        supportsLimited: false,
      },
      {
        key: 'configure',
        label: 'Configure Leave Policy',
        description: 'Define leave types, accrual rules, carry-forward and encashment policy',
        supportsLimited: false,
      },
    ],
  },
];

export const MODULE_FEATURES_MAP: Record<string, ModuleFeatureDefinition> =
  MODULE_FEATURES_REGISTRY.reduce(
    (acc, moduleDef) => {
      acc[moduleDef.module] = moduleDef;
      return acc;
    },
    {} as Record<string, ModuleFeatureDefinition>,
  );

export function getSubFeatureKeys(module: AppModule): string[] {
  const moduleDef = MODULE_FEATURES_MAP[module];
  return moduleDef ? moduleDef.subFeatures.map((sf) => sf.key) : [];
}

export function getSubFeatureDefinition(
  module: AppModule,
  key: string,
): SubFeatureDefinition | undefined {
  const moduleDef = MODULE_FEATURES_MAP[module];
  if (!moduleDef) return undefined;
  return moduleDef.subFeatures.find((sf) => sf.key === key);
}

export function getModuleDefinition(module: AppModule): ModuleFeatureDefinition | undefined {
  return MODULE_FEATURES_MAP[module];
}

/**
 * Builds a properly populated moduleAccess array for a given tier key.
 * Used during plan creation and subscription bootstrap to ensure moduleAccess
 * is never left as an empty array.
 */
/**
 * ManekHR module preset — the fixed, tier-INDEPENDENT set of modules this
 * single-brand copy ships. These `enabled` flags (not the ERP tier gates)
 * decide which modules are ON. ON = staff + salary + spine; OFF-but-available =
 * attendance / shifts / holidays / regularization / leave; the money +
 * manufacturing clusters are hard-off. The three FINANCE entries + REMINDERS +
 * MACHINES / LOCATIONS / RESOURCE_SCOPES also neutralize the ERP boot migration
 * services (finance-plan / machines-plan) so they cannot re-enable a cluster.
 */
export const MANEKHR_MODULE_PRESET: { key: AppModule; enabled: boolean }[] = [
  // --- ON (spine + core HR/salary product) ---
  { key: AppModule.TEAM, enabled: true },
  { key: AppModule.SALARY, enabled: true },
  { key: AppModule.SETTINGS, enabled: true },
  { key: AppModule.ROLES, enabled: true },

  // --- OFF but available (enabled:false default; flip per customer later) ---
  { key: AppModule.ATTENDANCE, enabled: false },
  { key: AppModule.SHIFTS, enabled: false },
  { key: AppModule.HOLIDAYS, enabled: false },
  { key: AppModule.REGULARIZATION, enabled: false },
  { key: AppModule.LEAVE, enabled: false },

  // --- EXCLUDED / hidden — money + accounting cluster (hard off) ---
  { key: AppModule.FINANCE, enabled: false },
  { key: AppModule.FINANCE_ADMIN, enabled: false },
  { key: AppModule.FINANCE_ACCOUNTANT, enabled: false },
  { key: AppModule.GST_COMPLIANCE, enabled: false },
  { key: AppModule.INVENTORY, enabled: false },
  { key: AppModule.MANUFACTURING, enabled: false },
  { key: AppModule.JOB_WORK, enabled: false },
  { key: AppModule.REMINDERS, enabled: false },

  // --- EXCLUDED / hidden — manufacturing / ops cluster (hard off) ---
  { key: AppModule.MACHINES, enabled: false },
  { key: AppModule.RESOURCE_SCOPES, enabled: false },
  { key: AppModule.DOWNTIME, enabled: false },
  { key: AppModule.MAINTENANCE, enabled: false },

  // --- ON — restored standalone (2026-07-04, owner directive): Locations is
  // no longer part of the excluded Machines cluster. Tracks employees' work
  // site; managed from Workspace Settings, consumed by Team's location field.
  { key: AppModule.LOCATIONS, enabled: true },
];

export function buildModuleAccess(tier?: string): Array<{
  module: AppModule;
  enabled: boolean;
  subFeatures: Array<{ key: string; access: FeatureAccessLevel }>;
}> {
  const tierKey = ['free', 'starter', 'pro', 'growth', 'business', 'enterprise', 'custom'].includes(
    tier,
  )
    ? tier
    : 'free';
  const tierDefaults = TIER_SUBFEATURE_DEFAULTS[tierKey] || TIER_SUBFEATURE_DEFAULTS.free;

  // ManekHR: which modules are ON comes from the fixed preset (tier-INDEPENDENT),
  // NOT the ERP tier gates. `tierDefaults` above still drives each module's
  // sub-feature ACCESS levels so sub-feature gating / migrations stay coherent.
  return MANEKHR_MODULE_PRESET.map((mod) => {
    const subFeatureDefs = tierDefaults[mod.key] || {};
    const subFeatures = Object.entries(subFeatureDefs).map(([key, access]) => ({
      key,
      access,
    }));
    return { module: mod.key, enabled: mod.enabled, subFeatures };
  });
}

export const DEFAULT_ACCESS_BY_TIER: Record<string, Record<string, FeatureAccessLevel>> = {
  free: {
    [AppModule.ATTENDANCE]: FeatureAccessLevel.FULL,
    [AppModule.TEAM]: FeatureAccessLevel.FULL,
    [AppModule.SALARY]: FeatureAccessLevel.FULL,
    [AppModule.SHIFTS]: FeatureAccessLevel.LOCKED,
    [AppModule.HOLIDAYS]: FeatureAccessLevel.LOCKED,
    [AppModule.ROLES]: FeatureAccessLevel.LOCKED,
    [AppModule.SETTINGS]: FeatureAccessLevel.FULL,
  },
  starter: {
    [AppModule.ATTENDANCE]: FeatureAccessLevel.FULL,
    [AppModule.TEAM]: FeatureAccessLevel.FULL,
    [AppModule.SALARY]: FeatureAccessLevel.FULL,
    [AppModule.SHIFTS]: FeatureAccessLevel.FULL,
    [AppModule.HOLIDAYS]: FeatureAccessLevel.FULL,
    [AppModule.ROLES]: FeatureAccessLevel.FULL,
    [AppModule.SETTINGS]: FeatureAccessLevel.FULL,
  },
  pro: {
    [AppModule.ATTENDANCE]: FeatureAccessLevel.FULL,
    [AppModule.TEAM]: FeatureAccessLevel.FULL,
    [AppModule.SALARY]: FeatureAccessLevel.FULL,
    [AppModule.SHIFTS]: FeatureAccessLevel.FULL,
    [AppModule.HOLIDAYS]: FeatureAccessLevel.FULL,
    [AppModule.ROLES]: FeatureAccessLevel.FULL,
    [AppModule.SETTINGS]: FeatureAccessLevel.FULL,
  },
  enterprise: {
    [AppModule.ATTENDANCE]: FeatureAccessLevel.FULL,
    [AppModule.TEAM]: FeatureAccessLevel.FULL,
    [AppModule.SALARY]: FeatureAccessLevel.FULL,
    [AppModule.SHIFTS]: FeatureAccessLevel.FULL,
    [AppModule.HOLIDAYS]: FeatureAccessLevel.FULL,
    [AppModule.ROLES]: FeatureAccessLevel.FULL,
    [AppModule.SETTINGS]: FeatureAccessLevel.FULL,
  },
  growth: {
    [AppModule.ATTENDANCE]: FeatureAccessLevel.FULL,
    [AppModule.TEAM]: FeatureAccessLevel.FULL,
    [AppModule.SALARY]: FeatureAccessLevel.FULL,
    [AppModule.SHIFTS]: FeatureAccessLevel.FULL,
    [AppModule.HOLIDAYS]: FeatureAccessLevel.FULL,
    [AppModule.ROLES]: FeatureAccessLevel.FULL,
    [AppModule.SETTINGS]: FeatureAccessLevel.FULL,
  },
  business: {
    [AppModule.ATTENDANCE]: FeatureAccessLevel.FULL,
    [AppModule.TEAM]: FeatureAccessLevel.FULL,
    [AppModule.SALARY]: FeatureAccessLevel.FULL,
    [AppModule.SHIFTS]: FeatureAccessLevel.FULL,
    [AppModule.HOLIDAYS]: FeatureAccessLevel.FULL,
    [AppModule.ROLES]: FeatureAccessLevel.FULL,
    [AppModule.SETTINGS]: FeatureAccessLevel.FULL,
  },
  custom: {
    [AppModule.ATTENDANCE]: FeatureAccessLevel.FULL,
    [AppModule.TEAM]: FeatureAccessLevel.FULL,
    [AppModule.SALARY]: FeatureAccessLevel.FULL,
    [AppModule.SHIFTS]: FeatureAccessLevel.FULL,
    [AppModule.HOLIDAYS]: FeatureAccessLevel.FULL,
    [AppModule.ROLES]: FeatureAccessLevel.FULL,
    [AppModule.SETTINGS]: FeatureAccessLevel.FULL,
  },
};

export const TIER_SUBFEATURE_DEFAULTS: Record<
  string,
  Record<string, Record<string, FeatureAccessLevel>>
> = {
  free: {
    [AppModule.ATTENDANCE]: {
      mark: FeatureAccessLevel.FULL,
      edit: FeatureAccessLevel.FULL,
      bulk_mark: FeatureAccessLevel.LOCKED,
      export_pdf: FeatureAccessLevel.LOCKED,
      export_excel: FeatureAccessLevel.LOCKED,
      auto_present: FeatureAccessLevel.LOCKED,
      advanced_filters: FeatureAccessLevel.LOCKED,
      per_employee_report: FeatureAccessLevel.LOCKED,
      date_range_export: FeatureAccessLevel.LOCKED,
      statutory_exports: FeatureAccessLevel.LOCKED,
      analytics_charts: FeatureAccessLevel.LOCKED,
    },
    [AppModule.TEAM]: {
      add_member: FeatureAccessLevel.FULL,
      edit_member: FeatureAccessLevel.FULL,
      remove_member: FeatureAccessLevel.FULL,
      bulk_import: FeatureAccessLevel.LOCKED,
      grant_app_access: FeatureAccessLevel.LOCKED,
      bulk_deactivate: FeatureAccessLevel.LOCKED,
      bulk_restore: FeatureAccessLevel.LOCKED,
      bulk_archive: FeatureAccessLevel.LOCKED,
      restore_member: FeatureAccessLevel.FULL,
      offboard_member: FeatureAccessLevel.LOCKED,
      export_team: FeatureAccessLevel.LOCKED,
      designation_filter: FeatureAccessLevel.LOCKED,
    },
    [AppModule.SALARY]: {
      generate_payroll: FeatureAccessLevel.FULL,
      record_payment: FeatureAccessLevel.FULL,
      edit_salary: FeatureAccessLevel.FULL,
      salary_adjustments_view: FeatureAccessLevel.FULL,
      salary_adjustments_create: FeatureAccessLevel.FULL,
      salary_adjustments_reverse: FeatureAccessLevel.FULL,
      salary_adjustments_edit_note: FeatureAccessLevel.FULL,
      salary_adjustments_view_audit: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.LOCKED,
      export_excel: FeatureAccessLevel.LOCKED,
      advance_payments: FeatureAccessLevel.LOCKED,
      split_payments: FeatureAccessLevel.LOCKED,
      bulk_payments: FeatureAccessLevel.LOCKED,
      commission_tracking: FeatureAccessLevel.LOCKED,
      salary_components: FeatureAccessLevel.LOCKED,
      payslip_generation: FeatureAccessLevel.LOCKED,
      statutory_compliance: FeatureAccessLevel.LOCKED,
      statutory_tds: FeatureAccessLevel.LOCKED,
      compliance_exports: FeatureAccessLevel.LOCKED,
      form16_generation: FeatureAccessLevel.LOCKED,
      payslip_email: FeatureAccessLevel.LOCKED,
      gratuity_tracking: FeatureAccessLevel.LOCKED,
      lwf_tracking: FeatureAccessLevel.LOCKED,
      tds_management: FeatureAccessLevel.LOCKED,
      fnf_settlement: FeatureAccessLevel.LOCKED,
      salary_increments: FeatureAccessLevel.LOCKED,
      reverse_payment: FeatureAccessLevel.FULL,
      // 2026-07-02 gating-gap batch — locked on free (basic salary only), like the
      // sibling paid-salary cluster. Keep in sync with the web registry.
      loan_management: FeatureAccessLevel.LOCKED,
      bonus_tracking: FeatureAccessLevel.LOCKED,
      daily_wage_ledger: FeatureAccessLevel.LOCKED,
    },
    [AppModule.SHIFTS]: {
      create_shift: FeatureAccessLevel.LOCKED,
      edit_shift: FeatureAccessLevel.LOCKED,
      delete_shift: FeatureAccessLevel.LOCKED,
    },
    [AppModule.HOLIDAYS]: {
      create_holiday: FeatureAccessLevel.LOCKED,
      edit_holiday: FeatureAccessLevel.LOCKED,
      delete_holiday: FeatureAccessLevel.LOCKED,
    },
    [AppModule.ROLES]: {
      create_role: FeatureAccessLevel.LOCKED,
      edit_role: FeatureAccessLevel.LOCKED,
      delete_role: FeatureAccessLevel.LOCKED,
    },
    [AppModule.SETTINGS]: {
      edit_settings: FeatureAccessLevel.FULL,
      workspace_branding: FeatureAccessLevel.LOCKED,
      pdf_branding: FeatureAccessLevel.LOCKED,
    },
  },
  starter: {
    [AppModule.ATTENDANCE]: {
      mark: FeatureAccessLevel.FULL,
      edit: FeatureAccessLevel.FULL,
      bulk_mark: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.LIMITED,
      export_excel: FeatureAccessLevel.LIMITED,
      auto_present: FeatureAccessLevel.FULL,
      advanced_filters: FeatureAccessLevel.FULL,
      per_employee_report: FeatureAccessLevel.FULL,
      date_range_export: FeatureAccessLevel.FULL,
      statutory_exports: FeatureAccessLevel.LOCKED,
      analytics_charts: FeatureAccessLevel.LOCKED,
    },
    [AppModule.TEAM]: {
      add_member: FeatureAccessLevel.FULL,
      edit_member: FeatureAccessLevel.FULL,
      remove_member: FeatureAccessLevel.FULL,
      bulk_import: FeatureAccessLevel.LOCKED,
      grant_app_access: FeatureAccessLevel.LOCKED,
      bulk_deactivate: FeatureAccessLevel.LOCKED,
      bulk_restore: FeatureAccessLevel.LOCKED,
      bulk_archive: FeatureAccessLevel.LOCKED,
      restore_member: FeatureAccessLevel.FULL,
      offboard_member: FeatureAccessLevel.LOCKED,
      export_team: FeatureAccessLevel.LOCKED,
      designation_filter: FeatureAccessLevel.FULL,
    },
    [AppModule.SALARY]: {
      generate_payroll: FeatureAccessLevel.FULL,
      record_payment: FeatureAccessLevel.FULL,
      edit_salary: FeatureAccessLevel.FULL,
      salary_adjustments_view: FeatureAccessLevel.FULL,
      salary_adjustments_create: FeatureAccessLevel.FULL,
      salary_adjustments_reverse: FeatureAccessLevel.FULL,
      salary_adjustments_edit_note: FeatureAccessLevel.FULL,
      salary_adjustments_view_audit: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.LIMITED,
      export_excel: FeatureAccessLevel.LIMITED,
      advance_payments: FeatureAccessLevel.FULL,
      split_payments: FeatureAccessLevel.FULL,
      bulk_payments: FeatureAccessLevel.FULL,
      commission_tracking: FeatureAccessLevel.FULL,
      salary_components: FeatureAccessLevel.LOCKED,
      payslip_generation: FeatureAccessLevel.LIMITED,
      statutory_compliance: FeatureAccessLevel.LOCKED,
      statutory_tds: FeatureAccessLevel.LOCKED,
      compliance_exports: FeatureAccessLevel.LOCKED,
      form16_generation: FeatureAccessLevel.LOCKED,
      payslip_email: FeatureAccessLevel.LOCKED,
      gratuity_tracking: FeatureAccessLevel.LOCKED,
      lwf_tracking: FeatureAccessLevel.LOCKED,
      tds_management: FeatureAccessLevel.LOCKED,
      fnf_settlement: FeatureAccessLevel.LOCKED,
      salary_increments: FeatureAccessLevel.FULL,
      reverse_payment: FeatureAccessLevel.FULL,
      // 2026-07-02 gating-gap batch — FULL on every paid tier, mirroring the sibling
      // paid-salary cluster. Keep in sync with the web registry.
      loan_management: FeatureAccessLevel.FULL,
      bonus_tracking: FeatureAccessLevel.FULL,
      daily_wage_ledger: FeatureAccessLevel.FULL,
    },
    [AppModule.SHIFTS]: {
      create_shift: FeatureAccessLevel.FULL,
      edit_shift: FeatureAccessLevel.FULL,
      delete_shift: FeatureAccessLevel.FULL,
    },
    [AppModule.HOLIDAYS]: {
      create_holiday: FeatureAccessLevel.FULL,
      edit_holiday: FeatureAccessLevel.FULL,
      delete_holiday: FeatureAccessLevel.FULL,
    },
    [AppModule.ROLES]: {
      create_role: FeatureAccessLevel.FULL,
      edit_role: FeatureAccessLevel.FULL,
      delete_role: FeatureAccessLevel.FULL,
    },
    [AppModule.SETTINGS]: {
      edit_settings: FeatureAccessLevel.FULL,
      workspace_branding: FeatureAccessLevel.LOCKED,
      pdf_branding: FeatureAccessLevel.LOCKED,
    },
  },
  pro: {
    [AppModule.ATTENDANCE]: {
      mark: FeatureAccessLevel.FULL,
      edit: FeatureAccessLevel.FULL,
      bulk_mark: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      auto_present: FeatureAccessLevel.FULL,
      advanced_filters: FeatureAccessLevel.FULL,
      per_employee_report: FeatureAccessLevel.FULL,
      date_range_export: FeatureAccessLevel.FULL,
      statutory_exports: FeatureAccessLevel.FULL,
      analytics_charts: FeatureAccessLevel.FULL,
    },
    [AppModule.TEAM]: {
      add_member: FeatureAccessLevel.FULL,
      edit_member: FeatureAccessLevel.FULL,
      remove_member: FeatureAccessLevel.FULL,
      bulk_import: FeatureAccessLevel.FULL,
      grant_app_access: FeatureAccessLevel.FULL,
      bulk_deactivate: FeatureAccessLevel.FULL,
      bulk_restore: FeatureAccessLevel.FULL,
      bulk_archive: FeatureAccessLevel.FULL,
      restore_member: FeatureAccessLevel.FULL,
      offboard_member: FeatureAccessLevel.FULL,
      export_team: FeatureAccessLevel.FULL,
      designation_filter: FeatureAccessLevel.FULL,
    },
    [AppModule.SALARY]: {
      generate_payroll: FeatureAccessLevel.FULL,
      record_payment: FeatureAccessLevel.FULL,
      edit_salary: FeatureAccessLevel.FULL,
      salary_adjustments_view: FeatureAccessLevel.FULL,
      salary_adjustments_create: FeatureAccessLevel.FULL,
      salary_adjustments_reverse: FeatureAccessLevel.FULL,
      salary_adjustments_edit_note: FeatureAccessLevel.FULL,
      salary_adjustments_view_audit: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      advance_payments: FeatureAccessLevel.FULL,
      split_payments: FeatureAccessLevel.FULL,
      bulk_payments: FeatureAccessLevel.FULL,
      commission_tracking: FeatureAccessLevel.FULL,
      salary_components: FeatureAccessLevel.FULL,
      payslip_generation: FeatureAccessLevel.FULL,
      statutory_compliance: FeatureAccessLevel.FULL,
      statutory_tds: FeatureAccessLevel.FULL,
      compliance_exports: FeatureAccessLevel.FULL,
      form16_generation: FeatureAccessLevel.FULL,
      payslip_email: FeatureAccessLevel.FULL,
      gratuity_tracking: FeatureAccessLevel.FULL,
      lwf_tracking: FeatureAccessLevel.FULL,
      tds_management: FeatureAccessLevel.FULL,
      fnf_settlement: FeatureAccessLevel.FULL,
      salary_increments: FeatureAccessLevel.FULL,
      reverse_payment: FeatureAccessLevel.FULL,
      // 2026-07-02 gating-gap batch — FULL on every paid tier, mirroring the sibling
      // paid-salary cluster. Keep in sync with the web registry.
      loan_management: FeatureAccessLevel.FULL,
      bonus_tracking: FeatureAccessLevel.FULL,
      daily_wage_ledger: FeatureAccessLevel.FULL,
    },
    [AppModule.SHIFTS]: {
      create_shift: FeatureAccessLevel.FULL,
      edit_shift: FeatureAccessLevel.FULL,
      delete_shift: FeatureAccessLevel.FULL,
    },
    [AppModule.HOLIDAYS]: {
      create_holiday: FeatureAccessLevel.FULL,
      edit_holiday: FeatureAccessLevel.FULL,
      delete_holiday: FeatureAccessLevel.FULL,
    },
    [AppModule.ROLES]: {
      create_role: FeatureAccessLevel.FULL,
      edit_role: FeatureAccessLevel.FULL,
      delete_role: FeatureAccessLevel.FULL,
    },
    [AppModule.SETTINGS]: {
      edit_settings: FeatureAccessLevel.FULL,
      workspace_branding: FeatureAccessLevel.FULL,
      pdf_branding: FeatureAccessLevel.FULL,
    },
  },
  enterprise: {
    [AppModule.ATTENDANCE]: {
      mark: FeatureAccessLevel.FULL,
      edit: FeatureAccessLevel.FULL,
      bulk_mark: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      auto_present: FeatureAccessLevel.FULL,
      advanced_filters: FeatureAccessLevel.FULL,
      per_employee_report: FeatureAccessLevel.FULL,
      date_range_export: FeatureAccessLevel.FULL,
      statutory_exports: FeatureAccessLevel.FULL,
      analytics_charts: FeatureAccessLevel.FULL,
    },
    [AppModule.TEAM]: {
      add_member: FeatureAccessLevel.FULL,
      edit_member: FeatureAccessLevel.FULL,
      remove_member: FeatureAccessLevel.FULL,
      bulk_import: FeatureAccessLevel.FULL,
      grant_app_access: FeatureAccessLevel.FULL,
      bulk_deactivate: FeatureAccessLevel.FULL,
      bulk_restore: FeatureAccessLevel.FULL,
      bulk_archive: FeatureAccessLevel.FULL,
      restore_member: FeatureAccessLevel.FULL,
      offboard_member: FeatureAccessLevel.FULL,
      export_team: FeatureAccessLevel.FULL,
      designation_filter: FeatureAccessLevel.FULL,
    },
    [AppModule.SALARY]: {
      generate_payroll: FeatureAccessLevel.FULL,
      record_payment: FeatureAccessLevel.FULL,
      edit_salary: FeatureAccessLevel.FULL,
      salary_adjustments_view: FeatureAccessLevel.FULL,
      salary_adjustments_create: FeatureAccessLevel.FULL,
      salary_adjustments_reverse: FeatureAccessLevel.FULL,
      salary_adjustments_edit_note: FeatureAccessLevel.FULL,
      salary_adjustments_view_audit: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      advance_payments: FeatureAccessLevel.FULL,
      split_payments: FeatureAccessLevel.FULL,
      bulk_payments: FeatureAccessLevel.FULL,
      commission_tracking: FeatureAccessLevel.FULL,
      salary_components: FeatureAccessLevel.FULL,
      payslip_generation: FeatureAccessLevel.FULL,
      statutory_compliance: FeatureAccessLevel.FULL,
      statutory_tds: FeatureAccessLevel.FULL,
      compliance_exports: FeatureAccessLevel.FULL,
      form16_generation: FeatureAccessLevel.FULL,
      payslip_email: FeatureAccessLevel.FULL,
      gratuity_tracking: FeatureAccessLevel.FULL,
      lwf_tracking: FeatureAccessLevel.FULL,
      tds_management: FeatureAccessLevel.FULL,
      fnf_settlement: FeatureAccessLevel.FULL,
      salary_increments: FeatureAccessLevel.FULL,
      reverse_payment: FeatureAccessLevel.FULL,
      // 2026-07-02 gating-gap batch — FULL on every paid tier, mirroring the sibling
      // paid-salary cluster. Keep in sync with the web registry.
      loan_management: FeatureAccessLevel.FULL,
      bonus_tracking: FeatureAccessLevel.FULL,
      daily_wage_ledger: FeatureAccessLevel.FULL,
    },
    [AppModule.SHIFTS]: {
      create_shift: FeatureAccessLevel.FULL,
      edit_shift: FeatureAccessLevel.FULL,
      delete_shift: FeatureAccessLevel.FULL,
    },
    [AppModule.HOLIDAYS]: {
      create_holiday: FeatureAccessLevel.FULL,
      edit_holiday: FeatureAccessLevel.FULL,
      delete_holiday: FeatureAccessLevel.FULL,
    },
    [AppModule.ROLES]: {
      create_role: FeatureAccessLevel.FULL,
      edit_role: FeatureAccessLevel.FULL,
      delete_role: FeatureAccessLevel.FULL,
    },
    [AppModule.SETTINGS]: {
      edit_settings: FeatureAccessLevel.FULL,
      workspace_branding: FeatureAccessLevel.FULL,
      pdf_branding: FeatureAccessLevel.FULL,
    },
  },
  growth: {
    [AppModule.ATTENDANCE]: {
      mark: FeatureAccessLevel.FULL,
      edit: FeatureAccessLevel.FULL,
      bulk_mark: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      auto_present: FeatureAccessLevel.FULL,
      advanced_filters: FeatureAccessLevel.FULL,
      per_employee_report: FeatureAccessLevel.FULL,
      date_range_export: FeatureAccessLevel.FULL,
      statutory_exports: FeatureAccessLevel.FULL,
      analytics_charts: FeatureAccessLevel.FULL,
    },
    [AppModule.TEAM]: {
      add_member: FeatureAccessLevel.FULL,
      edit_member: FeatureAccessLevel.FULL,
      remove_member: FeatureAccessLevel.FULL,
      bulk_import: FeatureAccessLevel.FULL,
      grant_app_access: FeatureAccessLevel.FULL,
      bulk_deactivate: FeatureAccessLevel.FULL,
      bulk_restore: FeatureAccessLevel.FULL,
      bulk_archive: FeatureAccessLevel.FULL,
      restore_member: FeatureAccessLevel.FULL,
      offboard_member: FeatureAccessLevel.FULL,
      export_team: FeatureAccessLevel.FULL,
      designation_filter: FeatureAccessLevel.FULL,
    },
    [AppModule.SALARY]: {
      generate_payroll: FeatureAccessLevel.FULL,
      record_payment: FeatureAccessLevel.FULL,
      edit_salary: FeatureAccessLevel.FULL,
      salary_adjustments_view: FeatureAccessLevel.FULL,
      salary_adjustments_create: FeatureAccessLevel.FULL,
      salary_adjustments_reverse: FeatureAccessLevel.FULL,
      salary_adjustments_edit_note: FeatureAccessLevel.FULL,
      salary_adjustments_view_audit: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      advance_payments: FeatureAccessLevel.FULL,
      split_payments: FeatureAccessLevel.FULL,
      bulk_payments: FeatureAccessLevel.FULL,
      commission_tracking: FeatureAccessLevel.FULL,
      salary_components: FeatureAccessLevel.FULL,
      payslip_generation: FeatureAccessLevel.FULL,
      statutory_compliance: FeatureAccessLevel.FULL,
      statutory_tds: FeatureAccessLevel.FULL,
      compliance_exports: FeatureAccessLevel.FULL,
      form16_generation: FeatureAccessLevel.FULL,
      payslip_email: FeatureAccessLevel.FULL,
      gratuity_tracking: FeatureAccessLevel.FULL,
      lwf_tracking: FeatureAccessLevel.FULL,
      tds_management: FeatureAccessLevel.FULL,
      fnf_settlement: FeatureAccessLevel.FULL,
      salary_increments: FeatureAccessLevel.FULL,
      reverse_payment: FeatureAccessLevel.FULL,
      // 2026-07-02 gating-gap batch — FULL on every paid tier, mirroring the sibling
      // paid-salary cluster. Keep in sync with the web registry.
      loan_management: FeatureAccessLevel.FULL,
      bonus_tracking: FeatureAccessLevel.FULL,
      daily_wage_ledger: FeatureAccessLevel.FULL,
    },
    [AppModule.SHIFTS]: {
      create_shift: FeatureAccessLevel.FULL,
      edit_shift: FeatureAccessLevel.FULL,
      delete_shift: FeatureAccessLevel.FULL,
    },
    [AppModule.HOLIDAYS]: {
      create_holiday: FeatureAccessLevel.FULL,
      edit_holiday: FeatureAccessLevel.FULL,
      delete_holiday: FeatureAccessLevel.FULL,
    },
    [AppModule.ROLES]: {
      create_role: FeatureAccessLevel.FULL,
      edit_role: FeatureAccessLevel.FULL,
      delete_role: FeatureAccessLevel.FULL,
    },
    [AppModule.SETTINGS]: {
      edit_settings: FeatureAccessLevel.FULL,
      workspace_branding: FeatureAccessLevel.FULL,
      pdf_branding: FeatureAccessLevel.FULL,
    },
  },
  business: {
    [AppModule.ATTENDANCE]: {
      mark: FeatureAccessLevel.FULL,
      edit: FeatureAccessLevel.FULL,
      bulk_mark: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      auto_present: FeatureAccessLevel.FULL,
      advanced_filters: FeatureAccessLevel.FULL,
      per_employee_report: FeatureAccessLevel.FULL,
      date_range_export: FeatureAccessLevel.FULL,
      statutory_exports: FeatureAccessLevel.FULL,
      analytics_charts: FeatureAccessLevel.FULL,
    },
    [AppModule.TEAM]: {
      add_member: FeatureAccessLevel.FULL,
      edit_member: FeatureAccessLevel.FULL,
      remove_member: FeatureAccessLevel.FULL,
      bulk_import: FeatureAccessLevel.FULL,
      grant_app_access: FeatureAccessLevel.FULL,
      bulk_deactivate: FeatureAccessLevel.FULL,
      bulk_restore: FeatureAccessLevel.FULL,
      bulk_archive: FeatureAccessLevel.FULL,
      restore_member: FeatureAccessLevel.FULL,
      offboard_member: FeatureAccessLevel.FULL,
      export_team: FeatureAccessLevel.FULL,
      designation_filter: FeatureAccessLevel.FULL,
    },
    [AppModule.SALARY]: {
      generate_payroll: FeatureAccessLevel.FULL,
      record_payment: FeatureAccessLevel.FULL,
      edit_salary: FeatureAccessLevel.FULL,
      salary_adjustments_view: FeatureAccessLevel.FULL,
      salary_adjustments_create: FeatureAccessLevel.FULL,
      salary_adjustments_reverse: FeatureAccessLevel.FULL,
      salary_adjustments_edit_note: FeatureAccessLevel.FULL,
      salary_adjustments_view_audit: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      advance_payments: FeatureAccessLevel.FULL,
      split_payments: FeatureAccessLevel.FULL,
      bulk_payments: FeatureAccessLevel.FULL,
      commission_tracking: FeatureAccessLevel.FULL,
      salary_components: FeatureAccessLevel.FULL,
      payslip_generation: FeatureAccessLevel.FULL,
      statutory_compliance: FeatureAccessLevel.FULL,
      statutory_tds: FeatureAccessLevel.FULL,
      compliance_exports: FeatureAccessLevel.FULL,
      form16_generation: FeatureAccessLevel.FULL,
      payslip_email: FeatureAccessLevel.FULL,
      gratuity_tracking: FeatureAccessLevel.FULL,
      lwf_tracking: FeatureAccessLevel.FULL,
      tds_management: FeatureAccessLevel.FULL,
      fnf_settlement: FeatureAccessLevel.FULL,
      salary_increments: FeatureAccessLevel.FULL,
      reverse_payment: FeatureAccessLevel.FULL,
      // 2026-07-02 gating-gap batch — FULL on every paid tier, mirroring the sibling
      // paid-salary cluster. Keep in sync with the web registry.
      loan_management: FeatureAccessLevel.FULL,
      bonus_tracking: FeatureAccessLevel.FULL,
      daily_wage_ledger: FeatureAccessLevel.FULL,
    },
    [AppModule.SHIFTS]: {
      create_shift: FeatureAccessLevel.FULL,
      edit_shift: FeatureAccessLevel.FULL,
      delete_shift: FeatureAccessLevel.FULL,
    },
    [AppModule.HOLIDAYS]: {
      create_holiday: FeatureAccessLevel.FULL,
      edit_holiday: FeatureAccessLevel.FULL,
      delete_holiday: FeatureAccessLevel.FULL,
    },
    [AppModule.ROLES]: {
      create_role: FeatureAccessLevel.FULL,
      edit_role: FeatureAccessLevel.FULL,
      delete_role: FeatureAccessLevel.FULL,
    },
    [AppModule.SETTINGS]: {
      edit_settings: FeatureAccessLevel.FULL,
      workspace_branding: FeatureAccessLevel.FULL,
      pdf_branding: FeatureAccessLevel.FULL,
    },
  },
  custom: {
    [AppModule.ATTENDANCE]: {
      mark: FeatureAccessLevel.FULL,
      edit: FeatureAccessLevel.FULL,
      bulk_mark: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      auto_present: FeatureAccessLevel.FULL,
      advanced_filters: FeatureAccessLevel.FULL,
      per_employee_report: FeatureAccessLevel.FULL,
      date_range_export: FeatureAccessLevel.FULL,
      statutory_exports: FeatureAccessLevel.FULL,
      analytics_charts: FeatureAccessLevel.FULL,
    },
    [AppModule.TEAM]: {
      add_member: FeatureAccessLevel.FULL,
      edit_member: FeatureAccessLevel.FULL,
      remove_member: FeatureAccessLevel.FULL,
      bulk_import: FeatureAccessLevel.FULL,
      grant_app_access: FeatureAccessLevel.FULL,
      bulk_deactivate: FeatureAccessLevel.FULL,
      bulk_restore: FeatureAccessLevel.FULL,
      bulk_archive: FeatureAccessLevel.FULL,
      restore_member: FeatureAccessLevel.FULL,
      offboard_member: FeatureAccessLevel.FULL,
      export_team: FeatureAccessLevel.FULL,
      designation_filter: FeatureAccessLevel.FULL,
    },
    [AppModule.SALARY]: {
      generate_payroll: FeatureAccessLevel.FULL,
      record_payment: FeatureAccessLevel.FULL,
      edit_salary: FeatureAccessLevel.FULL,
      salary_adjustments_view: FeatureAccessLevel.FULL,
      salary_adjustments_create: FeatureAccessLevel.FULL,
      salary_adjustments_reverse: FeatureAccessLevel.FULL,
      salary_adjustments_edit_note: FeatureAccessLevel.FULL,
      salary_adjustments_view_audit: FeatureAccessLevel.FULL,
      export_pdf: FeatureAccessLevel.FULL,
      export_excel: FeatureAccessLevel.FULL,
      advance_payments: FeatureAccessLevel.FULL,
      split_payments: FeatureAccessLevel.FULL,
      bulk_payments: FeatureAccessLevel.FULL,
      commission_tracking: FeatureAccessLevel.FULL,
      salary_components: FeatureAccessLevel.FULL,
      payslip_generation: FeatureAccessLevel.FULL,
      statutory_compliance: FeatureAccessLevel.FULL,
      statutory_tds: FeatureAccessLevel.FULL,
      compliance_exports: FeatureAccessLevel.FULL,
      form16_generation: FeatureAccessLevel.FULL,
      payslip_email: FeatureAccessLevel.FULL,
      gratuity_tracking: FeatureAccessLevel.FULL,
      lwf_tracking: FeatureAccessLevel.FULL,
      tds_management: FeatureAccessLevel.FULL,
      fnf_settlement: FeatureAccessLevel.FULL,
      salary_increments: FeatureAccessLevel.FULL,
      reverse_payment: FeatureAccessLevel.FULL,
      // 2026-07-02 gating-gap batch — FULL on every paid tier, mirroring the sibling
      // paid-salary cluster. Keep in sync with the web registry.
      loan_management: FeatureAccessLevel.FULL,
      bonus_tracking: FeatureAccessLevel.FULL,
      daily_wage_ledger: FeatureAccessLevel.FULL,
    },
    [AppModule.SHIFTS]: {
      create_shift: FeatureAccessLevel.FULL,
      edit_shift: FeatureAccessLevel.FULL,
      delete_shift: FeatureAccessLevel.FULL,
    },
    [AppModule.HOLIDAYS]: {
      create_holiday: FeatureAccessLevel.FULL,
      edit_holiday: FeatureAccessLevel.FULL,
      delete_holiday: FeatureAccessLevel.FULL,
    },
    [AppModule.ROLES]: {
      create_role: FeatureAccessLevel.FULL,
      edit_role: FeatureAccessLevel.FULL,
      delete_role: FeatureAccessLevel.FULL,
    },
    [AppModule.SETTINGS]: {
      edit_settings: FeatureAccessLevel.FULL,
      workspace_branding: FeatureAccessLevel.FULL,
      pdf_branding: FeatureAccessLevel.FULL,
    },
  },
};

/**
 * Pass-3 audit additions — tier defaults for newly-promoted modules.
 *
 * Modules promoted in audit:
 *   GST_COMPLIANCE, INVENTORY, MANUFACTURING, JOB_WORK,
 *   REGULARIZATION, DOWNTIME, MAINTENANCE
 *
 * Tier policy (per locked decisions in MODULE_INVENTORY.md §3.5):
 *   • Free      → mostly LOCKED (only `gst_gstin_lookup` Free)
 *   • Starter   → basic GST (e-invoice/e-waybill/verify) + basic Inventory
 *   • Pro       → legacy alias for Growth — same access as Growth
 *   • Growth    → full except Manufacturing.bom_costing, GST.gstr3b_filing, Maintenance
 *   • Business  → full except Maintenance
 *   • Enterprise → all FULL
 *   • Custom    → all FULL (admin-overridden anyway)
 */
const _NEW_MODULE_TIER_DEFAULTS: Record<
  string,
  Partial<Record<AppModule, Record<string, FeatureAccessLevel>>>
> = {
  free: {
    [AppModule.GST_COMPLIANCE]: {
      gstin_lookup: FeatureAccessLevel.FULL,
      einvoice_generation: FeatureAccessLevel.LOCKED,
      ewaybill_generation: FeatureAccessLevel.LOCKED,
      verify_my_data: FeatureAccessLevel.LOCKED,
      gstr1_filing: FeatureAccessLevel.LOCKED,
      gstr3b_filing: FeatureAccessLevel.LOCKED,
      itc04_filing: FeatureAccessLevel.LOCKED,
    },
    [AppModule.INVENTORY]: {
      items_master: FeatureAccessLevel.FULL,
      stock_summary: FeatureAccessLevel.FULL,
      stock_movements_view: FeatureAccessLevel.FULL,
      godowns: FeatureAccessLevel.LOCKED,
      lots: FeatureAccessLevel.LOCKED,
      batches: FeatureAccessLevel.LOCKED,
      serial_tracking: FeatureAccessLevel.LOCKED,
      samples: FeatureAccessLevel.LOCKED,
      stock_transfers: FeatureAccessLevel.LOCKED,
      wastage: FeatureAccessLevel.LOCKED,
      barcode: FeatureAccessLevel.LOCKED,
      cess_rules: FeatureAccessLevel.LOCKED,
    },
    [AppModule.MANUFACTURING]: {
      bom_crud: FeatureAccessLevel.LOCKED,
      bom_explosion: FeatureAccessLevel.LOCKED,
      bom_costing: FeatureAccessLevel.LOCKED,
      manufacturing_voucher: FeatureAccessLevel.LOCKED,
      manufacturing_voucher_lifecycle: FeatureAccessLevel.LOCKED,
      manufacturing_voucher_register: FeatureAccessLevel.LOCKED,
    },
    [AppModule.JOB_WORK]: {
      outward: FeatureAccessLevel.LOCKED,
      inward: FeatureAccessLevel.LOCKED,
      invoicing: FeatureAccessLevel.LOCKED,
      lots: FeatureAccessLevel.LOCKED,
      itc04: FeatureAccessLevel.LOCKED,
    },
    [AppModule.REGULARIZATION]: {
      request: FeatureAccessLevel.LOCKED,
      approve: FeatureAccessLevel.LOCKED,
      reject: FeatureAccessLevel.LOCKED,
      view_audit: FeatureAccessLevel.LOCKED,
    },
    [AppModule.DOWNTIME]: {
      view: FeatureAccessLevel.LOCKED,
      log: FeatureAccessLevel.LOCKED,
      manage_reasons: FeatureAccessLevel.LOCKED,
    },
    [AppModule.MAINTENANCE]: {
      view: FeatureAccessLevel.LOCKED,
      schedule: FeatureAccessLevel.LOCKED,
      log: FeatureAccessLevel.LOCKED,
      manage: FeatureAccessLevel.LOCKED,
    },
    [AppModule.LEAVE]: {
      apply: FeatureAccessLevel.LOCKED,
      approve: FeatureAccessLevel.LOCKED,
      view_balance: FeatureAccessLevel.LOCKED,
      configure: FeatureAccessLevel.LOCKED,
    },
  },
  starter: {
    [AppModule.GST_COMPLIANCE]: {
      gstin_lookup: FeatureAccessLevel.FULL,
      einvoice_generation: FeatureAccessLevel.FULL,
      ewaybill_generation: FeatureAccessLevel.FULL,
      verify_my_data: FeatureAccessLevel.FULL,
      gstr1_filing: FeatureAccessLevel.LOCKED,
      gstr3b_filing: FeatureAccessLevel.LOCKED,
      itc04_filing: FeatureAccessLevel.LOCKED,
    },
    [AppModule.INVENTORY]: {
      items_master: FeatureAccessLevel.FULL,
      stock_summary: FeatureAccessLevel.FULL,
      stock_movements_view: FeatureAccessLevel.FULL,
      godowns: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      batches: FeatureAccessLevel.FULL,
      serial_tracking: FeatureAccessLevel.LOCKED,
      samples: FeatureAccessLevel.LOCKED,
      stock_transfers: FeatureAccessLevel.FULL,
      wastage: FeatureAccessLevel.FULL,
      barcode: FeatureAccessLevel.FULL,
      cess_rules: FeatureAccessLevel.LOCKED,
    },
    [AppModule.MANUFACTURING]: {
      bom_crud: FeatureAccessLevel.LOCKED,
      bom_explosion: FeatureAccessLevel.LOCKED,
      bom_costing: FeatureAccessLevel.LOCKED,
      manufacturing_voucher: FeatureAccessLevel.LOCKED,
      manufacturing_voucher_lifecycle: FeatureAccessLevel.LOCKED,
      manufacturing_voucher_register: FeatureAccessLevel.LOCKED,
    },
    [AppModule.JOB_WORK]: {
      outward: FeatureAccessLevel.LOCKED,
      inward: FeatureAccessLevel.LOCKED,
      invoicing: FeatureAccessLevel.LOCKED,
      lots: FeatureAccessLevel.LOCKED,
      itc04: FeatureAccessLevel.LOCKED,
    },
    // LEAVE + REGULARIZATION now unlock at STARTER (see buildModuleAccess
    // enable flags). Mirror the growth tier's FULL sub-feature defaults so a
    // starter subscription gets a usable module, not an enabled-but-empty one.
    // Keep in sync with the growth LEAVE/REGULARIZATION blocks below.
    [AppModule.REGULARIZATION]: {
      request: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      reject: FeatureAccessLevel.FULL,
      view_audit: FeatureAccessLevel.FULL,
    },
    // DOWNTIME / MAINTENANCE stay LOCKED at starter (production = business+).
    [AppModule.DOWNTIME]: {
      view: FeatureAccessLevel.LOCKED,
      log: FeatureAccessLevel.LOCKED,
      manage_reasons: FeatureAccessLevel.LOCKED,
    },
    [AppModule.MAINTENANCE]: {
      view: FeatureAccessLevel.LOCKED,
      schedule: FeatureAccessLevel.LOCKED,
      log: FeatureAccessLevel.LOCKED,
      manage: FeatureAccessLevel.LOCKED,
    },
    [AppModule.LEAVE]: {
      apply: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      view_balance: FeatureAccessLevel.FULL,
      configure: FeatureAccessLevel.FULL,
    },
  },
  pro: {
    [AppModule.GST_COMPLIANCE]: {
      gstin_lookup: FeatureAccessLevel.FULL,
      einvoice_generation: FeatureAccessLevel.FULL,
      ewaybill_generation: FeatureAccessLevel.FULL,
      verify_my_data: FeatureAccessLevel.FULL,
      gstr1_filing: FeatureAccessLevel.FULL,
      gstr3b_filing: FeatureAccessLevel.LOCKED,
      itc04_filing: FeatureAccessLevel.FULL,
    },
    [AppModule.INVENTORY]: {
      items_master: FeatureAccessLevel.FULL,
      stock_summary: FeatureAccessLevel.FULL,
      stock_movements_view: FeatureAccessLevel.FULL,
      godowns: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      batches: FeatureAccessLevel.FULL,
      serial_tracking: FeatureAccessLevel.FULL,
      samples: FeatureAccessLevel.FULL,
      stock_transfers: FeatureAccessLevel.FULL,
      wastage: FeatureAccessLevel.FULL,
      barcode: FeatureAccessLevel.FULL,
      cess_rules: FeatureAccessLevel.FULL,
    },
    [AppModule.MANUFACTURING]: {
      bom_crud: FeatureAccessLevel.FULL,
      bom_explosion: FeatureAccessLevel.FULL,
      bom_costing: FeatureAccessLevel.LOCKED,
      manufacturing_voucher: FeatureAccessLevel.FULL,
      manufacturing_voucher_lifecycle: FeatureAccessLevel.FULL,
      manufacturing_voucher_register: FeatureAccessLevel.FULL,
    },
    [AppModule.JOB_WORK]: {
      outward: FeatureAccessLevel.FULL,
      inward: FeatureAccessLevel.FULL,
      invoicing: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      itc04: FeatureAccessLevel.FULL,
    },
    [AppModule.REGULARIZATION]: {
      request: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      reject: FeatureAccessLevel.FULL,
      view_audit: FeatureAccessLevel.FULL,
    },
    [AppModule.DOWNTIME]: {
      view: FeatureAccessLevel.FULL,
      log: FeatureAccessLevel.FULL,
      manage_reasons: FeatureAccessLevel.FULL,
    },
    [AppModule.MAINTENANCE]: {
      view: FeatureAccessLevel.LOCKED,
      schedule: FeatureAccessLevel.LOCKED,
      log: FeatureAccessLevel.LOCKED,
      manage: FeatureAccessLevel.LOCKED,
    },
    [AppModule.LEAVE]: {
      apply: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      view_balance: FeatureAccessLevel.FULL,
      configure: FeatureAccessLevel.FULL,
    },
  },
  growth: {
    [AppModule.GST_COMPLIANCE]: {
      gstin_lookup: FeatureAccessLevel.FULL,
      einvoice_generation: FeatureAccessLevel.FULL,
      ewaybill_generation: FeatureAccessLevel.FULL,
      verify_my_data: FeatureAccessLevel.FULL,
      gstr1_filing: FeatureAccessLevel.FULL,
      gstr3b_filing: FeatureAccessLevel.LOCKED,
      itc04_filing: FeatureAccessLevel.FULL,
    },
    [AppModule.INVENTORY]: {
      items_master: FeatureAccessLevel.FULL,
      stock_summary: FeatureAccessLevel.FULL,
      stock_movements_view: FeatureAccessLevel.FULL,
      godowns: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      batches: FeatureAccessLevel.FULL,
      serial_tracking: FeatureAccessLevel.FULL,
      samples: FeatureAccessLevel.FULL,
      stock_transfers: FeatureAccessLevel.FULL,
      wastage: FeatureAccessLevel.FULL,
      barcode: FeatureAccessLevel.FULL,
      cess_rules: FeatureAccessLevel.FULL,
    },
    [AppModule.MANUFACTURING]: {
      bom_crud: FeatureAccessLevel.FULL,
      bom_explosion: FeatureAccessLevel.FULL,
      bom_costing: FeatureAccessLevel.LOCKED,
      manufacturing_voucher: FeatureAccessLevel.FULL,
      manufacturing_voucher_lifecycle: FeatureAccessLevel.FULL,
      manufacturing_voucher_register: FeatureAccessLevel.FULL,
    },
    [AppModule.JOB_WORK]: {
      outward: FeatureAccessLevel.FULL,
      inward: FeatureAccessLevel.FULL,
      invoicing: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      itc04: FeatureAccessLevel.FULL,
    },
    [AppModule.REGULARIZATION]: {
      request: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      reject: FeatureAccessLevel.FULL,
      view_audit: FeatureAccessLevel.FULL,
    },
    [AppModule.DOWNTIME]: {
      view: FeatureAccessLevel.FULL,
      log: FeatureAccessLevel.FULL,
      manage_reasons: FeatureAccessLevel.FULL,
    },
    [AppModule.MAINTENANCE]: {
      view: FeatureAccessLevel.LOCKED,
      schedule: FeatureAccessLevel.LOCKED,
      log: FeatureAccessLevel.LOCKED,
      manage: FeatureAccessLevel.LOCKED,
    },
    [AppModule.LEAVE]: {
      apply: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      view_balance: FeatureAccessLevel.FULL,
      configure: FeatureAccessLevel.FULL,
    },
  },
  business: {
    [AppModule.GST_COMPLIANCE]: {
      gstin_lookup: FeatureAccessLevel.FULL,
      einvoice_generation: FeatureAccessLevel.FULL,
      ewaybill_generation: FeatureAccessLevel.FULL,
      verify_my_data: FeatureAccessLevel.FULL,
      gstr1_filing: FeatureAccessLevel.FULL,
      gstr3b_filing: FeatureAccessLevel.FULL,
      itc04_filing: FeatureAccessLevel.FULL,
    },
    [AppModule.INVENTORY]: {
      items_master: FeatureAccessLevel.FULL,
      stock_summary: FeatureAccessLevel.FULL,
      stock_movements_view: FeatureAccessLevel.FULL,
      godowns: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      batches: FeatureAccessLevel.FULL,
      serial_tracking: FeatureAccessLevel.FULL,
      samples: FeatureAccessLevel.FULL,
      stock_transfers: FeatureAccessLevel.FULL,
      wastage: FeatureAccessLevel.FULL,
      barcode: FeatureAccessLevel.FULL,
      cess_rules: FeatureAccessLevel.FULL,
    },
    [AppModule.MANUFACTURING]: {
      bom_crud: FeatureAccessLevel.FULL,
      bom_explosion: FeatureAccessLevel.FULL,
      bom_costing: FeatureAccessLevel.FULL,
      manufacturing_voucher: FeatureAccessLevel.FULL,
      manufacturing_voucher_lifecycle: FeatureAccessLevel.FULL,
      manufacturing_voucher_register: FeatureAccessLevel.FULL,
    },
    [AppModule.JOB_WORK]: {
      outward: FeatureAccessLevel.FULL,
      inward: FeatureAccessLevel.FULL,
      invoicing: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      itc04: FeatureAccessLevel.FULL,
    },
    [AppModule.REGULARIZATION]: {
      request: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      reject: FeatureAccessLevel.FULL,
      view_audit: FeatureAccessLevel.FULL,
    },
    [AppModule.DOWNTIME]: {
      view: FeatureAccessLevel.FULL,
      log: FeatureAccessLevel.FULL,
      manage_reasons: FeatureAccessLevel.FULL,
    },
    [AppModule.MAINTENANCE]: {
      view: FeatureAccessLevel.LOCKED,
      schedule: FeatureAccessLevel.LOCKED,
      log: FeatureAccessLevel.LOCKED,
      manage: FeatureAccessLevel.LOCKED,
    },
    [AppModule.LEAVE]: {
      apply: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      view_balance: FeatureAccessLevel.FULL,
      configure: FeatureAccessLevel.FULL,
    },
  },
  enterprise: {
    [AppModule.GST_COMPLIANCE]: {
      gstin_lookup: FeatureAccessLevel.FULL,
      einvoice_generation: FeatureAccessLevel.FULL,
      ewaybill_generation: FeatureAccessLevel.FULL,
      verify_my_data: FeatureAccessLevel.FULL,
      gstr1_filing: FeatureAccessLevel.FULL,
      gstr3b_filing: FeatureAccessLevel.FULL,
      itc04_filing: FeatureAccessLevel.FULL,
    },
    [AppModule.INVENTORY]: {
      items_master: FeatureAccessLevel.FULL,
      stock_summary: FeatureAccessLevel.FULL,
      stock_movements_view: FeatureAccessLevel.FULL,
      godowns: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      batches: FeatureAccessLevel.FULL,
      serial_tracking: FeatureAccessLevel.FULL,
      samples: FeatureAccessLevel.FULL,
      stock_transfers: FeatureAccessLevel.FULL,
      wastage: FeatureAccessLevel.FULL,
      barcode: FeatureAccessLevel.FULL,
      cess_rules: FeatureAccessLevel.FULL,
    },
    [AppModule.MANUFACTURING]: {
      bom_crud: FeatureAccessLevel.FULL,
      bom_explosion: FeatureAccessLevel.FULL,
      bom_costing: FeatureAccessLevel.FULL,
      manufacturing_voucher: FeatureAccessLevel.FULL,
      manufacturing_voucher_lifecycle: FeatureAccessLevel.FULL,
      manufacturing_voucher_register: FeatureAccessLevel.FULL,
    },
    [AppModule.JOB_WORK]: {
      outward: FeatureAccessLevel.FULL,
      inward: FeatureAccessLevel.FULL,
      invoicing: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      itc04: FeatureAccessLevel.FULL,
    },
    [AppModule.REGULARIZATION]: {
      request: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      reject: FeatureAccessLevel.FULL,
      view_audit: FeatureAccessLevel.FULL,
    },
    [AppModule.DOWNTIME]: {
      view: FeatureAccessLevel.FULL,
      log: FeatureAccessLevel.FULL,
      manage_reasons: FeatureAccessLevel.FULL,
    },
    [AppModule.MAINTENANCE]: {
      view: FeatureAccessLevel.FULL,
      schedule: FeatureAccessLevel.FULL,
      log: FeatureAccessLevel.FULL,
      manage: FeatureAccessLevel.FULL,
    },
    [AppModule.LEAVE]: {
      apply: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      view_balance: FeatureAccessLevel.FULL,
      configure: FeatureAccessLevel.FULL,
    },
  },
  custom: {
    [AppModule.GST_COMPLIANCE]: {
      gstin_lookup: FeatureAccessLevel.FULL,
      einvoice_generation: FeatureAccessLevel.FULL,
      ewaybill_generation: FeatureAccessLevel.FULL,
      verify_my_data: FeatureAccessLevel.FULL,
      gstr1_filing: FeatureAccessLevel.FULL,
      gstr3b_filing: FeatureAccessLevel.FULL,
      itc04_filing: FeatureAccessLevel.FULL,
    },
    [AppModule.INVENTORY]: {
      items_master: FeatureAccessLevel.FULL,
      stock_summary: FeatureAccessLevel.FULL,
      stock_movements_view: FeatureAccessLevel.FULL,
      godowns: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      batches: FeatureAccessLevel.FULL,
      serial_tracking: FeatureAccessLevel.FULL,
      samples: FeatureAccessLevel.FULL,
      stock_transfers: FeatureAccessLevel.FULL,
      wastage: FeatureAccessLevel.FULL,
      barcode: FeatureAccessLevel.FULL,
      cess_rules: FeatureAccessLevel.FULL,
    },
    [AppModule.MANUFACTURING]: {
      bom_crud: FeatureAccessLevel.FULL,
      bom_explosion: FeatureAccessLevel.FULL,
      bom_costing: FeatureAccessLevel.FULL,
      manufacturing_voucher: FeatureAccessLevel.FULL,
      manufacturing_voucher_lifecycle: FeatureAccessLevel.FULL,
      manufacturing_voucher_register: FeatureAccessLevel.FULL,
    },
    [AppModule.JOB_WORK]: {
      outward: FeatureAccessLevel.FULL,
      inward: FeatureAccessLevel.FULL,
      invoicing: FeatureAccessLevel.FULL,
      lots: FeatureAccessLevel.FULL,
      itc04: FeatureAccessLevel.FULL,
    },
    [AppModule.REGULARIZATION]: {
      request: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      reject: FeatureAccessLevel.FULL,
      view_audit: FeatureAccessLevel.FULL,
    },
    [AppModule.DOWNTIME]: {
      view: FeatureAccessLevel.FULL,
      log: FeatureAccessLevel.FULL,
      manage_reasons: FeatureAccessLevel.FULL,
    },
    [AppModule.MAINTENANCE]: {
      view: FeatureAccessLevel.FULL,
      schedule: FeatureAccessLevel.FULL,
      log: FeatureAccessLevel.FULL,
      manage: FeatureAccessLevel.FULL,
    },
    [AppModule.LEAVE]: {
      apply: FeatureAccessLevel.FULL,
      approve: FeatureAccessLevel.FULL,
      view_balance: FeatureAccessLevel.FULL,
      configure: FeatureAccessLevel.FULL,
    },
  },
};

// Merge new module defaults into TIER_SUBFEATURE_DEFAULTS at module load.
// Done as a runtime merge to avoid editing 7 large existing tier blocks above.
for (const [tier, modules] of Object.entries(_NEW_MODULE_TIER_DEFAULTS)) {
  if (!TIER_SUBFEATURE_DEFAULTS[tier]) {
    TIER_SUBFEATURE_DEFAULTS[tier] = {};
  }
  Object.assign(TIER_SUBFEATURE_DEFAULTS[tier], modules);
}

/**
 * Wave 4 audit additions — FINANCE + REMINDERS sub-feature tier defaults.
 *
 * Until Wave 4 these two modules had NO tier-default block in
 * TIER_SUBFEATURE_DEFAULTS. The 41 existing finance-gated controllers
 * (parties, items, ledger, fiscal-year, manufacturing, gst, etc.) all relied
 * on the SubscriptionGuard's "empty subFeatures => FULL" fallback, which
 * worked only because their subscriptions had `subFeatures: []` injected by
 * FinancePlanMigrationService at boot. The fallback breaks the moment the
 * array gets even one entry — so Wave 4 must register EVERY legacy alias
 * (`finance_basic`, `finance_advanced`, `gst_compliance`, `job_work`, `bom`,
 * `manufacturing_voucher`, `party_intelligence*`, `finance_accountant_invite`)
 * with FULL access at the same tier they used to enjoy implicitly.
 *
 * Tier policy (locked decisions — see plan file):
 *   • Free      → finance_basic + sales_invoicing + payments + parties + basic accounting + reminders/in-app/email FULL.
 *   • Starter   → + sales_quotations/orders/dc/proforma/credit_debit_notes, purchases_orders/grn, accounting_recycle_bin, reminder rules/templates/settings/auto_escalation.
 *   • Pro       → legacy alias for Growth — same access as Growth.
 *   • Growth    → + sales_recurring_billing, purchases_ocr/payment_outward/capital_goods_itc/payables, banking_bank_accounts/cheques, accounting_journal/contra, fixed_assets_*, reports_financial, party_intelligence*, gst_compliance, job_work, bom, manufacturing_voucher.
 *   • Business  → + banking_loan_accounts, party_portal_access, finance_accountant_invite.
 *   • Enterprise → + finance_advanced, accounting_tally_export, reminder_channel_push.
 *   • Custom    → all FULL (admin-overridden anyway).
 *
 * SMS / WhatsApp stay LOCKED at every tier — they unlock per-workspace via
 * the credit-pack add-on (planned, not in this wave). Push is Enterprise only.
 */
const _WAVE4_FINANCE_REMINDERS_TIER_DEFAULTS: Record<
  string,
  Partial<Record<AppModule, Record<string, FeatureAccessLevel>>>
> = {
  free: {
    [AppModule.FINANCE]: {
      // Wave 7 — bare legacy aliases dropped (now inert post-canonical re-key)
      finance_accountant_invite: FeatureAccessLevel.LOCKED,
      party_intelligence_rfm: FeatureAccessLevel.LOCKED,
      party_intelligence_gstin_monitor: FeatureAccessLevel.LOCKED,
      party_intelligence_timeline: FeatureAccessLevel.LOCKED,
      party_intelligence_pnl: FeatureAccessLevel.LOCKED,
      party_intelligence_greetings: FeatureAccessLevel.LOCKED,
      // Sales
      sales_invoicing: FeatureAccessLevel.FULL,
      sales_orders: FeatureAccessLevel.LOCKED,
      sales_quotations: FeatureAccessLevel.LOCKED,
      sales_proforma: FeatureAccessLevel.LOCKED,
      sales_delivery_challans: FeatureAccessLevel.LOCKED,
      sales_recurring_billing: FeatureAccessLevel.LOCKED,
      sales_credit_debit_notes: FeatureAccessLevel.LOCKED,
      // Purchases
      purchases_invoicing: FeatureAccessLevel.FULL,
      purchases_orders: FeatureAccessLevel.LOCKED,
      purchases_grn: FeatureAccessLevel.LOCKED,
      purchases_grn_returns: FeatureAccessLevel.LOCKED,
      purchases_expenses: FeatureAccessLevel.FULL,
      purchases_ocr: FeatureAccessLevel.LOCKED,
      purchases_payment_outward: FeatureAccessLevel.LOCKED,
      purchases_capital_goods_itc: FeatureAccessLevel.LOCKED,
      purchases_payables: FeatureAccessLevel.LOCKED,
      // Payments
      payments_payment_in: FeatureAccessLevel.FULL,
      payments_party_ledger: FeatureAccessLevel.FULL,
      // Banking
      banking_bank_accounts: FeatureAccessLevel.LOCKED,
      banking_cheques: FeatureAccessLevel.LOCKED,
      banking_loan_accounts: FeatureAccessLevel.LOCKED,
      // Accounting
      accounting_journal_entries: FeatureAccessLevel.LOCKED,
      accounting_contra_entries: FeatureAccessLevel.LOCKED,
      accounting_coa: FeatureAccessLevel.FULL,
      accounting_fiscal_years: FeatureAccessLevel.FULL,
      accounting_voucher_series: FeatureAccessLevel.FULL,
      accounting_items_master: FeatureAccessLevel.FULL,
      accounting_setup_checklist: FeatureAccessLevel.FULL,
      accounting_recycle_bin: FeatureAccessLevel.LOCKED,
      accounting_tally_export: FeatureAccessLevel.LOCKED,
      accounting_cash_registers: FeatureAccessLevel.FULL,
      // Fixed assets
      fixed_assets_categories: FeatureAccessLevel.LOCKED,
      fixed_assets_register: FeatureAccessLevel.LOCKED,
      fixed_assets_depreciation: FeatureAccessLevel.LOCKED,
      fixed_assets_disposal: FeatureAccessLevel.LOCKED,
      fixed_assets_linking: FeatureAccessLevel.LOCKED,
      fixed_assets_reports: FeatureAccessLevel.LOCKED,
      // Reports + Parties
      reports_financial: FeatureAccessLevel.LOCKED,
      parties_master: FeatureAccessLevel.FULL,
      party_portal_access: FeatureAccessLevel.LOCKED,
    },
    [AppModule.REMINDERS]: {
      reminder_rules_view: FeatureAccessLevel.FULL,
      reminder_rules_manage: FeatureAccessLevel.LOCKED,
      reminder_settings_manage: FeatureAccessLevel.LOCKED,
      reminder_templates_customize: FeatureAccessLevel.LOCKED,
      reminder_channel_in_app: FeatureAccessLevel.FULL,
      reminder_channel_email: FeatureAccessLevel.FULL,
      reminder_channel_sms: FeatureAccessLevel.LOCKED,
      reminder_channel_whatsapp: FeatureAccessLevel.LOCKED,
      reminder_channel_push: FeatureAccessLevel.LOCKED,
      reminder_call_todo_view: FeatureAccessLevel.FULL,
      reminder_call_todo_manage: FeatureAccessLevel.LOCKED,
      reminder_auto_escalation: FeatureAccessLevel.LOCKED,
      reminder_audit_log: FeatureAccessLevel.FULL,
      reminder_dispatcher_run: FeatureAccessLevel.FULL,
    },
  },
  starter: {
    [AppModule.FINANCE]: {
      // Wave 7 — bare legacy aliases dropped
      finance_accountant_invite: FeatureAccessLevel.LOCKED,
      party_intelligence_rfm: FeatureAccessLevel.LOCKED,
      party_intelligence_gstin_monitor: FeatureAccessLevel.LOCKED,
      party_intelligence_timeline: FeatureAccessLevel.LOCKED,
      party_intelligence_pnl: FeatureAccessLevel.LOCKED,
      party_intelligence_greetings: FeatureAccessLevel.LOCKED,
      sales_invoicing: FeatureAccessLevel.FULL,
      sales_orders: FeatureAccessLevel.FULL,
      sales_quotations: FeatureAccessLevel.FULL,
      sales_proforma: FeatureAccessLevel.FULL,
      sales_delivery_challans: FeatureAccessLevel.FULL,
      sales_recurring_billing: FeatureAccessLevel.LOCKED,
      sales_credit_debit_notes: FeatureAccessLevel.FULL,
      purchases_invoicing: FeatureAccessLevel.FULL,
      purchases_orders: FeatureAccessLevel.FULL,
      purchases_grn: FeatureAccessLevel.FULL,
      purchases_grn_returns: FeatureAccessLevel.FULL,
      purchases_expenses: FeatureAccessLevel.FULL,
      purchases_ocr: FeatureAccessLevel.LOCKED,
      purchases_payment_outward: FeatureAccessLevel.LOCKED,
      purchases_capital_goods_itc: FeatureAccessLevel.LOCKED,
      purchases_payables: FeatureAccessLevel.LOCKED,
      payments_payment_in: FeatureAccessLevel.FULL,
      payments_party_ledger: FeatureAccessLevel.FULL,
      banking_bank_accounts: FeatureAccessLevel.LOCKED,
      banking_cheques: FeatureAccessLevel.LOCKED,
      banking_loan_accounts: FeatureAccessLevel.LOCKED,
      accounting_journal_entries: FeatureAccessLevel.LOCKED,
      accounting_contra_entries: FeatureAccessLevel.LOCKED,
      accounting_coa: FeatureAccessLevel.FULL,
      accounting_fiscal_years: FeatureAccessLevel.FULL,
      accounting_voucher_series: FeatureAccessLevel.FULL,
      accounting_items_master: FeatureAccessLevel.FULL,
      accounting_setup_checklist: FeatureAccessLevel.FULL,
      accounting_recycle_bin: FeatureAccessLevel.FULL,
      accounting_tally_export: FeatureAccessLevel.LOCKED,
      accounting_cash_registers: FeatureAccessLevel.FULL,
      fixed_assets_categories: FeatureAccessLevel.LOCKED,
      fixed_assets_register: FeatureAccessLevel.LOCKED,
      fixed_assets_depreciation: FeatureAccessLevel.LOCKED,
      fixed_assets_disposal: FeatureAccessLevel.LOCKED,
      fixed_assets_linking: FeatureAccessLevel.LOCKED,
      fixed_assets_reports: FeatureAccessLevel.LOCKED,
      reports_financial: FeatureAccessLevel.LOCKED,
      parties_master: FeatureAccessLevel.FULL,
      party_portal_access: FeatureAccessLevel.LOCKED,
    },
    [AppModule.REMINDERS]: {
      reminder_rules_view: FeatureAccessLevel.FULL,
      reminder_rules_manage: FeatureAccessLevel.FULL,
      reminder_settings_manage: FeatureAccessLevel.FULL,
      reminder_templates_customize: FeatureAccessLevel.FULL,
      reminder_channel_in_app: FeatureAccessLevel.FULL,
      reminder_channel_email: FeatureAccessLevel.FULL,
      reminder_channel_sms: FeatureAccessLevel.LOCKED,
      reminder_channel_whatsapp: FeatureAccessLevel.LOCKED,
      reminder_channel_push: FeatureAccessLevel.LOCKED,
      reminder_call_todo_view: FeatureAccessLevel.FULL,
      reminder_call_todo_manage: FeatureAccessLevel.FULL,
      reminder_auto_escalation: FeatureAccessLevel.FULL,
      reminder_audit_log: FeatureAccessLevel.FULL,
      reminder_dispatcher_run: FeatureAccessLevel.FULL,
    },
  },
  pro: {
    [AppModule.FINANCE]: {
      // Wave 7 — bare legacy aliases dropped
      finance_accountant_invite: FeatureAccessLevel.LOCKED,
      party_intelligence_rfm: FeatureAccessLevel.FULL,
      party_intelligence_gstin_monitor: FeatureAccessLevel.FULL,
      party_intelligence_timeline: FeatureAccessLevel.FULL,
      party_intelligence_pnl: FeatureAccessLevel.FULL,
      party_intelligence_greetings: FeatureAccessLevel.FULL,
      sales_invoicing: FeatureAccessLevel.FULL,
      sales_orders: FeatureAccessLevel.FULL,
      sales_quotations: FeatureAccessLevel.FULL,
      sales_proforma: FeatureAccessLevel.FULL,
      sales_delivery_challans: FeatureAccessLevel.FULL,
      sales_recurring_billing: FeatureAccessLevel.FULL,
      sales_credit_debit_notes: FeatureAccessLevel.FULL,
      purchases_invoicing: FeatureAccessLevel.FULL,
      purchases_orders: FeatureAccessLevel.FULL,
      purchases_grn: FeatureAccessLevel.FULL,
      purchases_grn_returns: FeatureAccessLevel.FULL,
      purchases_expenses: FeatureAccessLevel.FULL,
      purchases_ocr: FeatureAccessLevel.FULL,
      purchases_payment_outward: FeatureAccessLevel.FULL,
      purchases_capital_goods_itc: FeatureAccessLevel.FULL,
      purchases_payables: FeatureAccessLevel.FULL,
      payments_payment_in: FeatureAccessLevel.FULL,
      payments_party_ledger: FeatureAccessLevel.FULL,
      banking_bank_accounts: FeatureAccessLevel.FULL,
      banking_cheques: FeatureAccessLevel.FULL,
      banking_loan_accounts: FeatureAccessLevel.LOCKED,
      accounting_journal_entries: FeatureAccessLevel.FULL,
      accounting_contra_entries: FeatureAccessLevel.FULL,
      accounting_coa: FeatureAccessLevel.FULL,
      accounting_fiscal_years: FeatureAccessLevel.FULL,
      accounting_voucher_series: FeatureAccessLevel.FULL,
      accounting_items_master: FeatureAccessLevel.FULL,
      accounting_setup_checklist: FeatureAccessLevel.FULL,
      accounting_recycle_bin: FeatureAccessLevel.FULL,
      accounting_tally_export: FeatureAccessLevel.LOCKED,
      accounting_cash_registers: FeatureAccessLevel.FULL,
      fixed_assets_categories: FeatureAccessLevel.FULL,
      fixed_assets_register: FeatureAccessLevel.FULL,
      fixed_assets_depreciation: FeatureAccessLevel.FULL,
      fixed_assets_disposal: FeatureAccessLevel.FULL,
      fixed_assets_linking: FeatureAccessLevel.FULL,
      fixed_assets_reports: FeatureAccessLevel.FULL,
      reports_financial: FeatureAccessLevel.FULL,
      parties_master: FeatureAccessLevel.FULL,
      party_portal_access: FeatureAccessLevel.LOCKED,
    },
    [AppModule.REMINDERS]: {
      reminder_rules_view: FeatureAccessLevel.FULL,
      reminder_rules_manage: FeatureAccessLevel.FULL,
      reminder_settings_manage: FeatureAccessLevel.FULL,
      reminder_templates_customize: FeatureAccessLevel.FULL,
      reminder_channel_in_app: FeatureAccessLevel.FULL,
      reminder_channel_email: FeatureAccessLevel.FULL,
      reminder_channel_sms: FeatureAccessLevel.LOCKED,
      reminder_channel_whatsapp: FeatureAccessLevel.LOCKED,
      reminder_channel_push: FeatureAccessLevel.LOCKED,
      reminder_call_todo_view: FeatureAccessLevel.FULL,
      reminder_call_todo_manage: FeatureAccessLevel.FULL,
      reminder_auto_escalation: FeatureAccessLevel.FULL,
      reminder_audit_log: FeatureAccessLevel.FULL,
      reminder_dispatcher_run: FeatureAccessLevel.FULL,
    },
  },
  growth: {
    [AppModule.FINANCE]: {
      // Wave 7 — bare legacy aliases dropped
      finance_accountant_invite: FeatureAccessLevel.LOCKED,
      party_intelligence_rfm: FeatureAccessLevel.FULL,
      party_intelligence_gstin_monitor: FeatureAccessLevel.FULL,
      party_intelligence_timeline: FeatureAccessLevel.FULL,
      party_intelligence_pnl: FeatureAccessLevel.FULL,
      party_intelligence_greetings: FeatureAccessLevel.FULL,
      sales_invoicing: FeatureAccessLevel.FULL,
      sales_orders: FeatureAccessLevel.FULL,
      sales_quotations: FeatureAccessLevel.FULL,
      sales_proforma: FeatureAccessLevel.FULL,
      sales_delivery_challans: FeatureAccessLevel.FULL,
      sales_recurring_billing: FeatureAccessLevel.FULL,
      sales_credit_debit_notes: FeatureAccessLevel.FULL,
      purchases_invoicing: FeatureAccessLevel.FULL,
      purchases_orders: FeatureAccessLevel.FULL,
      purchases_grn: FeatureAccessLevel.FULL,
      purchases_grn_returns: FeatureAccessLevel.FULL,
      purchases_expenses: FeatureAccessLevel.FULL,
      purchases_ocr: FeatureAccessLevel.FULL,
      purchases_payment_outward: FeatureAccessLevel.FULL,
      purchases_capital_goods_itc: FeatureAccessLevel.FULL,
      purchases_payables: FeatureAccessLevel.FULL,
      payments_payment_in: FeatureAccessLevel.FULL,
      payments_party_ledger: FeatureAccessLevel.FULL,
      banking_bank_accounts: FeatureAccessLevel.FULL,
      banking_cheques: FeatureAccessLevel.FULL,
      banking_loan_accounts: FeatureAccessLevel.LOCKED,
      accounting_journal_entries: FeatureAccessLevel.FULL,
      accounting_contra_entries: FeatureAccessLevel.FULL,
      accounting_coa: FeatureAccessLevel.FULL,
      accounting_fiscal_years: FeatureAccessLevel.FULL,
      accounting_voucher_series: FeatureAccessLevel.FULL,
      accounting_items_master: FeatureAccessLevel.FULL,
      accounting_setup_checklist: FeatureAccessLevel.FULL,
      accounting_recycle_bin: FeatureAccessLevel.FULL,
      accounting_tally_export: FeatureAccessLevel.LOCKED,
      accounting_cash_registers: FeatureAccessLevel.FULL,
      fixed_assets_categories: FeatureAccessLevel.FULL,
      fixed_assets_register: FeatureAccessLevel.FULL,
      fixed_assets_depreciation: FeatureAccessLevel.FULL,
      fixed_assets_disposal: FeatureAccessLevel.FULL,
      fixed_assets_linking: FeatureAccessLevel.FULL,
      fixed_assets_reports: FeatureAccessLevel.FULL,
      reports_financial: FeatureAccessLevel.FULL,
      parties_master: FeatureAccessLevel.FULL,
      party_portal_access: FeatureAccessLevel.LOCKED,
    },
    [AppModule.REMINDERS]: {
      reminder_rules_view: FeatureAccessLevel.FULL,
      reminder_rules_manage: FeatureAccessLevel.FULL,
      reminder_settings_manage: FeatureAccessLevel.FULL,
      reminder_templates_customize: FeatureAccessLevel.FULL,
      reminder_channel_in_app: FeatureAccessLevel.FULL,
      reminder_channel_email: FeatureAccessLevel.FULL,
      reminder_channel_sms: FeatureAccessLevel.LOCKED,
      reminder_channel_whatsapp: FeatureAccessLevel.LOCKED,
      reminder_channel_push: FeatureAccessLevel.LOCKED,
      reminder_call_todo_view: FeatureAccessLevel.FULL,
      reminder_call_todo_manage: FeatureAccessLevel.FULL,
      reminder_auto_escalation: FeatureAccessLevel.FULL,
      reminder_audit_log: FeatureAccessLevel.FULL,
      reminder_dispatcher_run: FeatureAccessLevel.FULL,
    },
  },
  business: {
    [AppModule.FINANCE]: {
      // Wave 7 — bare legacy aliases dropped
      finance_accountant_invite: FeatureAccessLevel.FULL,
      party_intelligence_rfm: FeatureAccessLevel.FULL,
      party_intelligence_gstin_monitor: FeatureAccessLevel.FULL,
      party_intelligence_timeline: FeatureAccessLevel.FULL,
      party_intelligence_pnl: FeatureAccessLevel.FULL,
      party_intelligence_greetings: FeatureAccessLevel.FULL,
      sales_invoicing: FeatureAccessLevel.FULL,
      sales_orders: FeatureAccessLevel.FULL,
      sales_quotations: FeatureAccessLevel.FULL,
      sales_proforma: FeatureAccessLevel.FULL,
      sales_delivery_challans: FeatureAccessLevel.FULL,
      sales_recurring_billing: FeatureAccessLevel.FULL,
      sales_credit_debit_notes: FeatureAccessLevel.FULL,
      purchases_invoicing: FeatureAccessLevel.FULL,
      purchases_orders: FeatureAccessLevel.FULL,
      purchases_grn: FeatureAccessLevel.FULL,
      purchases_grn_returns: FeatureAccessLevel.FULL,
      purchases_expenses: FeatureAccessLevel.FULL,
      purchases_ocr: FeatureAccessLevel.FULL,
      purchases_payment_outward: FeatureAccessLevel.FULL,
      purchases_capital_goods_itc: FeatureAccessLevel.FULL,
      purchases_payables: FeatureAccessLevel.FULL,
      payments_payment_in: FeatureAccessLevel.FULL,
      payments_party_ledger: FeatureAccessLevel.FULL,
      banking_bank_accounts: FeatureAccessLevel.FULL,
      banking_cheques: FeatureAccessLevel.FULL,
      banking_loan_accounts: FeatureAccessLevel.FULL,
      accounting_journal_entries: FeatureAccessLevel.FULL,
      accounting_contra_entries: FeatureAccessLevel.FULL,
      accounting_coa: FeatureAccessLevel.FULL,
      accounting_fiscal_years: FeatureAccessLevel.FULL,
      accounting_voucher_series: FeatureAccessLevel.FULL,
      accounting_items_master: FeatureAccessLevel.FULL,
      accounting_setup_checklist: FeatureAccessLevel.FULL,
      accounting_recycle_bin: FeatureAccessLevel.FULL,
      accounting_tally_export: FeatureAccessLevel.LOCKED,
      accounting_cash_registers: FeatureAccessLevel.FULL,
      fixed_assets_categories: FeatureAccessLevel.FULL,
      fixed_assets_register: FeatureAccessLevel.FULL,
      fixed_assets_depreciation: FeatureAccessLevel.FULL,
      fixed_assets_disposal: FeatureAccessLevel.FULL,
      fixed_assets_linking: FeatureAccessLevel.FULL,
      fixed_assets_reports: FeatureAccessLevel.FULL,
      reports_financial: FeatureAccessLevel.FULL,
      parties_master: FeatureAccessLevel.FULL,
      party_portal_access: FeatureAccessLevel.FULL,
    },
    [AppModule.REMINDERS]: {
      reminder_rules_view: FeatureAccessLevel.FULL,
      reminder_rules_manage: FeatureAccessLevel.FULL,
      reminder_settings_manage: FeatureAccessLevel.FULL,
      reminder_templates_customize: FeatureAccessLevel.FULL,
      reminder_channel_in_app: FeatureAccessLevel.FULL,
      reminder_channel_email: FeatureAccessLevel.FULL,
      reminder_channel_sms: FeatureAccessLevel.LOCKED,
      reminder_channel_whatsapp: FeatureAccessLevel.LOCKED,
      reminder_channel_push: FeatureAccessLevel.LOCKED,
      reminder_call_todo_view: FeatureAccessLevel.FULL,
      reminder_call_todo_manage: FeatureAccessLevel.FULL,
      reminder_auto_escalation: FeatureAccessLevel.FULL,
      reminder_audit_log: FeatureAccessLevel.FULL,
      reminder_dispatcher_run: FeatureAccessLevel.FULL,
    },
  },
  enterprise: {
    [AppModule.FINANCE]: {
      // Wave 7 — bare legacy aliases dropped
      finance_accountant_invite: FeatureAccessLevel.FULL,
      party_intelligence_rfm: FeatureAccessLevel.FULL,
      party_intelligence_gstin_monitor: FeatureAccessLevel.FULL,
      party_intelligence_timeline: FeatureAccessLevel.FULL,
      party_intelligence_pnl: FeatureAccessLevel.FULL,
      party_intelligence_greetings: FeatureAccessLevel.FULL,
      sales_invoicing: FeatureAccessLevel.FULL,
      sales_orders: FeatureAccessLevel.FULL,
      sales_quotations: FeatureAccessLevel.FULL,
      sales_proforma: FeatureAccessLevel.FULL,
      sales_delivery_challans: FeatureAccessLevel.FULL,
      sales_recurring_billing: FeatureAccessLevel.FULL,
      sales_credit_debit_notes: FeatureAccessLevel.FULL,
      purchases_invoicing: FeatureAccessLevel.FULL,
      purchases_orders: FeatureAccessLevel.FULL,
      purchases_grn: FeatureAccessLevel.FULL,
      purchases_grn_returns: FeatureAccessLevel.FULL,
      purchases_expenses: FeatureAccessLevel.FULL,
      purchases_ocr: FeatureAccessLevel.FULL,
      purchases_payment_outward: FeatureAccessLevel.FULL,
      purchases_capital_goods_itc: FeatureAccessLevel.FULL,
      purchases_payables: FeatureAccessLevel.FULL,
      payments_payment_in: FeatureAccessLevel.FULL,
      payments_party_ledger: FeatureAccessLevel.FULL,
      banking_bank_accounts: FeatureAccessLevel.FULL,
      banking_cheques: FeatureAccessLevel.FULL,
      banking_loan_accounts: FeatureAccessLevel.FULL,
      accounting_journal_entries: FeatureAccessLevel.FULL,
      accounting_contra_entries: FeatureAccessLevel.FULL,
      accounting_coa: FeatureAccessLevel.FULL,
      accounting_fiscal_years: FeatureAccessLevel.FULL,
      accounting_voucher_series: FeatureAccessLevel.FULL,
      accounting_items_master: FeatureAccessLevel.FULL,
      accounting_setup_checklist: FeatureAccessLevel.FULL,
      accounting_recycle_bin: FeatureAccessLevel.FULL,
      accounting_tally_export: FeatureAccessLevel.FULL,
      accounting_cash_registers: FeatureAccessLevel.FULL,
      fixed_assets_categories: FeatureAccessLevel.FULL,
      fixed_assets_register: FeatureAccessLevel.FULL,
      fixed_assets_depreciation: FeatureAccessLevel.FULL,
      fixed_assets_disposal: FeatureAccessLevel.FULL,
      fixed_assets_linking: FeatureAccessLevel.FULL,
      fixed_assets_reports: FeatureAccessLevel.FULL,
      reports_financial: FeatureAccessLevel.FULL,
      parties_master: FeatureAccessLevel.FULL,
      party_portal_access: FeatureAccessLevel.FULL,
    },
    [AppModule.REMINDERS]: {
      reminder_rules_view: FeatureAccessLevel.FULL,
      reminder_rules_manage: FeatureAccessLevel.FULL,
      reminder_settings_manage: FeatureAccessLevel.FULL,
      reminder_templates_customize: FeatureAccessLevel.FULL,
      reminder_channel_in_app: FeatureAccessLevel.FULL,
      reminder_channel_email: FeatureAccessLevel.FULL,
      reminder_channel_sms: FeatureAccessLevel.LOCKED,
      reminder_channel_whatsapp: FeatureAccessLevel.LOCKED,
      reminder_channel_push: FeatureAccessLevel.FULL,
      reminder_call_todo_view: FeatureAccessLevel.FULL,
      reminder_call_todo_manage: FeatureAccessLevel.FULL,
      reminder_auto_escalation: FeatureAccessLevel.FULL,
      reminder_audit_log: FeatureAccessLevel.FULL,
      reminder_dispatcher_run: FeatureAccessLevel.FULL,
    },
  },
  custom: {
    [AppModule.FINANCE]: {
      // Wave 7 — bare legacy aliases dropped
      finance_accountant_invite: FeatureAccessLevel.FULL,
      party_intelligence_rfm: FeatureAccessLevel.FULL,
      party_intelligence_gstin_monitor: FeatureAccessLevel.FULL,
      party_intelligence_timeline: FeatureAccessLevel.FULL,
      party_intelligence_pnl: FeatureAccessLevel.FULL,
      party_intelligence_greetings: FeatureAccessLevel.FULL,
      sales_invoicing: FeatureAccessLevel.FULL,
      sales_orders: FeatureAccessLevel.FULL,
      sales_quotations: FeatureAccessLevel.FULL,
      sales_proforma: FeatureAccessLevel.FULL,
      sales_delivery_challans: FeatureAccessLevel.FULL,
      sales_recurring_billing: FeatureAccessLevel.FULL,
      sales_credit_debit_notes: FeatureAccessLevel.FULL,
      purchases_invoicing: FeatureAccessLevel.FULL,
      purchases_orders: FeatureAccessLevel.FULL,
      purchases_grn: FeatureAccessLevel.FULL,
      purchases_grn_returns: FeatureAccessLevel.FULL,
      purchases_expenses: FeatureAccessLevel.FULL,
      purchases_ocr: FeatureAccessLevel.FULL,
      purchases_payment_outward: FeatureAccessLevel.FULL,
      purchases_capital_goods_itc: FeatureAccessLevel.FULL,
      purchases_payables: FeatureAccessLevel.FULL,
      payments_payment_in: FeatureAccessLevel.FULL,
      payments_party_ledger: FeatureAccessLevel.FULL,
      banking_bank_accounts: FeatureAccessLevel.FULL,
      banking_cheques: FeatureAccessLevel.FULL,
      banking_loan_accounts: FeatureAccessLevel.FULL,
      accounting_journal_entries: FeatureAccessLevel.FULL,
      accounting_contra_entries: FeatureAccessLevel.FULL,
      accounting_coa: FeatureAccessLevel.FULL,
      accounting_fiscal_years: FeatureAccessLevel.FULL,
      accounting_voucher_series: FeatureAccessLevel.FULL,
      accounting_items_master: FeatureAccessLevel.FULL,
      accounting_setup_checklist: FeatureAccessLevel.FULL,
      accounting_recycle_bin: FeatureAccessLevel.FULL,
      accounting_tally_export: FeatureAccessLevel.FULL,
      accounting_cash_registers: FeatureAccessLevel.FULL,
      fixed_assets_categories: FeatureAccessLevel.FULL,
      fixed_assets_register: FeatureAccessLevel.FULL,
      fixed_assets_depreciation: FeatureAccessLevel.FULL,
      fixed_assets_disposal: FeatureAccessLevel.FULL,
      fixed_assets_linking: FeatureAccessLevel.FULL,
      fixed_assets_reports: FeatureAccessLevel.FULL,
      reports_financial: FeatureAccessLevel.FULL,
      parties_master: FeatureAccessLevel.FULL,
      party_portal_access: FeatureAccessLevel.FULL,
    },
    [AppModule.REMINDERS]: {
      reminder_rules_view: FeatureAccessLevel.FULL,
      reminder_rules_manage: FeatureAccessLevel.FULL,
      reminder_settings_manage: FeatureAccessLevel.FULL,
      reminder_templates_customize: FeatureAccessLevel.FULL,
      reminder_channel_in_app: FeatureAccessLevel.FULL,
      reminder_channel_email: FeatureAccessLevel.FULL,
      reminder_channel_sms: FeatureAccessLevel.FULL,
      reminder_channel_whatsapp: FeatureAccessLevel.FULL,
      reminder_channel_push: FeatureAccessLevel.FULL,
      reminder_call_todo_view: FeatureAccessLevel.FULL,
      reminder_call_todo_manage: FeatureAccessLevel.FULL,
      reminder_auto_escalation: FeatureAccessLevel.FULL,
      reminder_audit_log: FeatureAccessLevel.FULL,
      reminder_dispatcher_run: FeatureAccessLevel.FULL,
    },
  },
};

for (const [tier, modules] of Object.entries(_WAVE4_FINANCE_REMINDERS_TIER_DEFAULTS)) {
  if (!TIER_SUBFEATURE_DEFAULTS[tier]) {
    TIER_SUBFEATURE_DEFAULTS[tier] = {};
  }
  for (const [moduleKey, subFeatures] of Object.entries(modules ?? {})) {
    if (!TIER_SUBFEATURE_DEFAULTS[tier][moduleKey]) {
      TIER_SUBFEATURE_DEFAULTS[tier][moduleKey] = {};
    }
    Object.assign(TIER_SUBFEATURE_DEFAULTS[tier][moduleKey], subFeatures);
  }
}

/**
 * Attendance defaulter-alerts sub-feature tier defaults (2026-05-17).
 * Seeds NEW subscriptions only; existing tenants are backfilled to FULL by
 * AttendancePlanMigrationService. free => LOCKED, all paid tiers => FULL.
 * Runtime-merged to avoid editing the 7 large tier blocks above.
 */
const _DEFAULTER_ALERTS_TIER_DEFAULTS: Record<
  string,
  Partial<Record<AppModule, Record<string, FeatureAccessLevel>>>
> = {
  free: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.LOCKED } },
  starter: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  pro: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  growth: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  business: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  enterprise: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
  custom: { [AppModule.ATTENDANCE]: { defaulter_alerts: FeatureAccessLevel.FULL } },
};
for (const [tier, modules] of Object.entries(_DEFAULTER_ALERTS_TIER_DEFAULTS)) {
  if (!TIER_SUBFEATURE_DEFAULTS[tier]) {
    TIER_SUBFEATURE_DEFAULTS[tier] = {};
  }
  for (const [moduleKey, subFeatures] of Object.entries(modules ?? {})) {
    if (!TIER_SUBFEATURE_DEFAULTS[tier][moduleKey]) {
      TIER_SUBFEATURE_DEFAULTS[tier][moduleKey] = {};
    }
    Object.assign(TIER_SUBFEATURE_DEFAULTS[tier][moduleKey], subFeatures);
  }
}

/**
 * Attendance feature-gating tier defaults (2026-05-17).
 * Seeds NEW subscriptions; existing tenants are backfilled tier-aware by
 * AttendancePlanMigrationService. attendance_muster unlocks at starter;
 * the 4 analytics/detection surfaces (overtime, compliance, patterns,
 * anomaly detection) unlock at pro+. Runtime-merged to avoid editing the
 * 7 large tier blocks above.
 */
const _ATTENDANCE_GATING_TIER_DEFAULTS: Record<
  string,
  Partial<Record<AppModule, Record<string, FeatureAccessLevel>>>
> = {
  free: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.LOCKED,
      overtime_analytics: FeatureAccessLevel.LOCKED,
      compliance_report: FeatureAccessLevel.LOCKED,
      absence_patterns: FeatureAccessLevel.LOCKED,
      anomaly_detection: FeatureAccessLevel.LOCKED,
    },
  },
  starter: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.LOCKED,
      compliance_report: FeatureAccessLevel.LOCKED,
      absence_patterns: FeatureAccessLevel.LOCKED,
      anomaly_detection: FeatureAccessLevel.LOCKED,
    },
  },
  pro: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
      anomaly_detection: FeatureAccessLevel.FULL,
    },
  },
  growth: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
      anomaly_detection: FeatureAccessLevel.FULL,
    },
  },
  business: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
      anomaly_detection: FeatureAccessLevel.FULL,
    },
  },
  enterprise: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
      anomaly_detection: FeatureAccessLevel.FULL,
    },
  },
  custom: {
    [AppModule.ATTENDANCE]: {
      attendance_muster: FeatureAccessLevel.FULL,
      overtime_analytics: FeatureAccessLevel.FULL,
      compliance_report: FeatureAccessLevel.FULL,
      absence_patterns: FeatureAccessLevel.FULL,
      anomaly_detection: FeatureAccessLevel.FULL,
    },
  },
};
for (const [tier, modules] of Object.entries(_ATTENDANCE_GATING_TIER_DEFAULTS)) {
  if (!TIER_SUBFEATURE_DEFAULTS[tier]) {
    TIER_SUBFEATURE_DEFAULTS[tier] = {};
  }
  for (const [moduleKey, subFeatures] of Object.entries(modules ?? {})) {
    if (!TIER_SUBFEATURE_DEFAULTS[tier][moduleKey]) {
      TIER_SUBFEATURE_DEFAULTS[tier][moduleKey] = {};
    }
    Object.assign(TIER_SUBFEATURE_DEFAULTS[tier][moduleKey], subFeatures);
  }
}
