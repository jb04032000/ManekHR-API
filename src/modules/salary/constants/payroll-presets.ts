export const PAYROLL_PRESETS = {
  basic: {
    features: {
      attendanceBasedPay: true,
      adjustments: true,
      // Advance payments ON by default (owner directive 2026-07-03) so employee
      // advance-salary requests work without per-workspace setup; kept in sync
      // with the schema default. Existing workspaces flipped by migration 0059.
      advancePayments: true,
      // Split Payments on by default (owner directive 2026-06-22) — basic preset is
      // what getPayrollConfig writes on insert, so this is the new-workspace default.
      splitPayments: true,
      commissionTracking: false,
      salaryComponents: false,
      payslipGeneration: false,
      bankDetails: true,
      proofAttachments: true,
      hourlySalary: true,
      // Employer-loan module ON by default (owner directive 2026-06-22) so the 0%
      // employee loan is available without per-workspace setup. Self-apply AND-gate
      // (loanConfig.selfApplyEnabled) is also defaulted on in the schema.
      loanManagement: true,
      bulkPayments: false,
      autoGenerate: false,
      salaryRevisions: false,
      salaryIncrements: false,
    },
    rules: { attendancePayModeDefault: 'enabled' },
    display: { defaultWorkingDays: 26, payCycle: 'monthly' },
  },
  standard: {
    features: {
      attendanceBasedPay: true,
      adjustments: true,
      advancePayments: true,
      splitPayments: true,
      commissionTracking: false,
      salaryComponents: false,
      payslipGeneration: false,
      bankDetails: true,
      proofAttachments: true,
      hourlySalary: true,
      // Employer-loan module ON by default (owner directive 2026-06-22) so the 0%
      // employee loan is available without per-workspace setup. Self-apply AND-gate
      // (loanConfig.selfApplyEnabled) is also defaulted on in the schema.
      loanManagement: true,
      bulkPayments: true,
      autoGenerate: false,
      salaryRevisions: true,
      salaryIncrements: true,
    },
    rules: { attendancePayModeDefault: 'enabled' },
    display: { defaultWorkingDays: 26, payCycle: 'monthly' },
  },
  professional: {
    features: {
      attendanceBasedPay: true,
      adjustments: true,
      advancePayments: true,
      splitPayments: true,
      commissionTracking: true,
      salaryComponents: true,
      payslipGeneration: true,
      bankDetails: true,
      proofAttachments: true,
      hourlySalary: true,
      // Employer-loan module ON by default (owner directive 2026-06-22) so the 0%
      // employee loan is available without per-workspace setup. Self-apply AND-gate
      // (loanConfig.selfApplyEnabled) is also defaulted on in the schema.
      loanManagement: true,
      bulkPayments: true,
      autoGenerate: true,
      salaryRevisions: true,
      salaryIncrements: true,
    },
    rules: { attendancePayModeDefault: 'enabled' },
    display: { defaultWorkingDays: 26, payCycle: 'monthly' },
  },
  enterprise: {
    features: {
      attendanceBasedPay: true,
      adjustments: true,
      advancePayments: true,
      splitPayments: true,
      commissionTracking: true,
      salaryComponents: true,
      payslipGeneration: true,
      bankDetails: true,
      proofAttachments: true,
      hourlySalary: true,
      // Employer-loan module ON by default (owner directive 2026-06-22) so the 0%
      // employee loan is available without per-workspace setup. Self-apply AND-gate
      // (loanConfig.selfApplyEnabled) is also defaulted on in the schema.
      loanManagement: true,
      bulkPayments: true,
      autoGenerate: true,
      salaryRevisions: true,
      salaryIncrements: true,
    },
    rules: { attendancePayModeDefault: 'enabled' },
    display: { defaultWorkingDays: 22, payCycle: 'monthly' },
  },
} as const;
