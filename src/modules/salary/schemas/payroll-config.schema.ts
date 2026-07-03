import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';

@Schema({ timestamps: true })
export class PayrollConfig extends Document {
  @Prop({
    type: Types.ObjectId,
    ref: 'Workspace',
    required: true,
    unique: true,
    index: true,
  })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({
    enum: ['basic', 'standard', 'professional', 'enterprise', 'custom'],
    default: 'basic',
  })
  preset: string;

  @Prop({ type: String })
  lastAutoGenerateKey?: string;

  @Prop({
    type: {
      attendanceBasedPay: { type: Boolean, default: true },
      adjustments: { type: Boolean, default: true },
      // Advance payments default-on (owner directive 2026-07-03); kept in sync
      // with the basic preset. Existing workspaces flipped by migration 0059.
      advancePayments: { type: Boolean, default: true },
      // Split Payments default-on (owner directive 2026-06-22); kept in sync with the basic preset.
      splitPayments: { type: Boolean, default: true },
      commissionTracking: { type: Boolean, default: false },
      salaryComponents: { type: Boolean, default: false },
      payslipGeneration: { type: Boolean, default: false },
      bankDetails: { type: Boolean, default: true },
      proofAttachments: { type: Boolean, default: true },
      hourlySalary: { type: Boolean, default: true },
      bulkPayments: { type: Boolean, default: false },
      autoGenerate: { type: Boolean, default: false },
      salaryRevisions: { type: Boolean, default: true },
      salaryIncrements: { type: Boolean, default: true },
      loanManagement: { type: Boolean, default: true },
      /**
       * Phase 3C: daily-wage running ledger (baki/udhaar) for piece-rate and
       * daily-wage karigars. When false, all CashLedgerService write endpoints
       * throw 400. Enable in Payroll Settings.
       */
      dailyWageLedger: { type: Boolean, default: false },
    },
    default: {
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
      bulkPayments: false,
      autoGenerate: false,
      salaryRevisions: true,
      salaryIncrements: true,
      loanManagement: true,
      dailyWageLedger: false,
    },
  })
  features: {
    attendanceBasedPay: boolean;
    adjustments: boolean;
    advancePayments: boolean;
    splitPayments: boolean;
    commissionTracking: boolean;
    salaryComponents: boolean;
    payslipGeneration: boolean;
    bankDetails: boolean;
    proofAttachments: boolean;
    hourlySalary: boolean;
    bulkPayments: boolean;
    autoGenerate: boolean;
    salaryRevisions: boolean;
    salaryIncrements: boolean;
    /** workspace-level toggle for the employer loan module */
    loanManagement: boolean;
    /** Phase 3C: daily-wage running ledger (baki/udhaar) for daily-wage workers */
    dailyWageLedger: boolean;
  };

  @Prop({
    type: {
      attendancePayModeDefault: {
        type: String,
        enum: ['enabled', 'disabled'],
        default: 'enabled',
      },
      holidayCountsAsPresent: { type: Boolean, default: true },
      weekOffCountsAsPresent: { type: Boolean, default: true },
      lateMarkAsHalfDay: { type: Boolean, default: false },
    },
    default: {
      attendancePayModeDefault: 'enabled',
      holidayCountsAsPresent: true,
      weekOffCountsAsPresent: true,
      lateMarkAsHalfDay: false,
    },
  })
  rules: {
    attendancePayModeDefault: 'enabled' | 'disabled';
    holidayCountsAsPresent: boolean;
    weekOffCountsAsPresent: boolean;
    lateMarkAsHalfDay: boolean;
  };

  @Prop({
    type: {
      salaryDate: { type: Number, default: 1, min: 1, max: 28 },
      payoutWindowDays: { type: Number, default: 5, min: 0, max: 28 },
      // Legacy single request-day lock. Retained for backward-compat and used as
      // the fallback day when advanceRequestPolicy is absent (pre-migration docs).
      advanceRequestDay: { type: Number, default: 15, min: 1, max: 28 },
      // Phase 1b two-step disburse: the fixed day-of-month the advance batch is
      // distributed (e.g. 25), distinct from salaryDate. null = not configured.
      // 1-28 so the day exists in every month. Informational on the disburse step.
      // Links: update-disbursement-rules.dto.ts, salary.service.ts payApprovedAdvance.
      advancePayoutDay: { type: Number, default: null, min: 1, max: 28 },
      // Worker advance-request timing policy. NEW workspaces default to 'any_day'
      // (applied on insert). EXISTING workspaces have no stored value -> the guard
      // reads the config with .lean() (no schema default applied) and falls back to
      // fixed_day(advanceRequestDay); the migration stamps them fixed_day explicitly
      // so a later hydrated save cannot silently flip them open.
      // Links: advance-request-window.util.ts, advance-salary-request.service.ts createRequest.
      advanceRequestPolicy: {
        type: {
          mode: {
            type: String,
            enum: ['any_day', 'window', 'fixed_day'],
            default: 'any_day',
          },
          fixedDay: { type: Number, min: 1, max: 28 },
          windowStartDay: { type: Number, min: 1, max: 31 },
          windowEndDay: { type: Number, min: 1, max: 31 },
        },
        _id: false,
        default: { mode: 'any_day' },
      },
      // Phase 3b: advance ELIGIBILITY CAPS — owner-configurable guardrails enforced
      // when a worker SUBMITS an advance request. ALL nullable = OFF by default
      // (additive, no migration; legacy docs read via .lean() with no default applied
      // so an absent value is `undefined` → the guard treats it as off).
      // Links: update-disbursement-rules.dto.ts, advance-salary-request.service.ts createRequest.
      //
      // A single request may not exceed this % of the member's monthly figure (1-100).
      advanceMaxPercentOfNet: { type: Number, default: null, min: 1, max: 100 },
      // Max number of advance requests a member may make per calendar year (>=1).
      advanceMaxPerYear: { type: Number, default: null, min: 1 },
      // Member must have at least N months of tenure (from dateOfJoining) to request (>=0).
      advanceMinTenureMonths: { type: Number, default: null, min: 0 },
    },
    default: {
      salaryDate: 1,
      payoutWindowDays: 5,
      advanceRequestDay: 15,
      advanceRequestPolicy: { mode: 'any_day' },
    },
    _id: false,
  })
  disbursementRules: {
    salaryDate: number;
    payoutWindowDays: number;
    advanceRequestDay: number;
    advancePayoutDay?: number | null;
    advanceRequestPolicy?: {
      mode: 'any_day' | 'window' | 'fixed_day';
      fixedDay?: number;
      windowStartDay?: number;
      windowEndDay?: number;
    };
    /** Phase 3b cap: single request <= X% of member monthly figure (1-100); null = off. */
    advanceMaxPercentOfNet?: number | null;
    /** Phase 3b cap: max advance requests per calendar year (>=1); null = off. */
    advanceMaxPerYear?: number | null;
    /** Phase 3b cap: min tenure months from dateOfJoining (>=0); null = off. */
    advanceMinTenureMonths?: number | null;
  };

  @Prop({
    type: {
      regularizationWindowDays: { type: Number, default: 45, min: 1, max: 90 },
      salaryLossEnabled: { type: Boolean, default: true },
    },
    default: { regularizationWindowDays: 45, salaryLossEnabled: true },
    _id: false,
  })
  salaryLossConfig: {
    regularizationWindowDays: number;
    salaryLossEnabled: boolean;
  };

  @Prop({
    type: {
      currencyCode: { type: String, default: 'INR' },
      currencySymbol: { type: String, default: '₹' },
      currencyLocale: { type: String, default: 'en-IN' },
      defaultWorkingDays: { type: Number, default: 26 },
      payDay: { type: Number, default: 1, min: 1, max: 28 },
      payCycle: {
        type: String,
        enum: ['monthly', 'biweekly', 'weekly'],
        default: 'monthly',
      },
      lastUsedCoaAccountId: { type: String },
    },
    default: {
      currencyCode: 'INR',
      currencySymbol: '₹',
      currencyLocale: 'en-IN',
      defaultWorkingDays: 26,
      payDay: 1,
      payCycle: 'monthly',
    },
  })
  display: {
    currencyCode: string;
    currencySymbol: string;
    currencyLocale: string;
    defaultWorkingDays: number;
    payDay: number;
    payCycle: string;
    lastUsedCoaAccountId?: string;
  };

  @Prop({
    type: {
      pfEnabled: { type: Boolean, default: false },
      pfEstablishmentCode: { type: String, default: '' },
      pfWageCeiling: { type: Number, default: 15000 },
      esiEnabled: { type: Boolean, default: false },
      esiCode: { type: String, default: '' },
      esiGrossThreshold: { type: Number, default: 21000 },
      ptEnabled: { type: Boolean, default: false },
      tdsEnabled: { type: Boolean, default: false },
      lwfEnabled: { type: Boolean, default: false },
      ptState: { type: String, default: 'Gujarat' },
      ptUseCustomSlabs: { type: Boolean, default: false },
      ptCustomSlabs: { type: [Object], default: [] },
    },
    default: {
      pfEnabled: false,
      pfEstablishmentCode: '',
      pfWageCeiling: 15000,
      esiEnabled: false,
      esiCode: '',
      esiGrossThreshold: 21000,
      ptEnabled: false,
      tdsEnabled: false,
      lwfEnabled: false,
      ptState: 'Gujarat',
      ptUseCustomSlabs: false,
      ptCustomSlabs: [],
    },
  })
  statutory: {
    pfEnabled: boolean;
    pfEstablishmentCode: string;
    pfWageCeiling: number;
    esiEnabled: boolean;
    esiCode: string;
    esiGrossThreshold: number;
    ptEnabled: boolean;
    tdsEnabled: boolean;
    lwfEnabled: boolean;
    ptState: string;
    ptUseCustomSlabs: boolean;
    ptCustomSlabs: Array<{
      minSalary: number;
      maxSalary: number | null;
      ptAmount: number;
    }>;
  };

  @Prop({
    type: {
      minimumWageMonthly: { type: Number, default: null },
      minimumWageCategory: {
        type: String,
        enum: ['unskilled', 'semi_skilled', 'skilled', 'highly_skilled'],
        default: 'unskilled',
      },
      deductionCapPercent: { type: Number, default: 50 },
      installmentAdvisoryOneThirdEnabled: { type: Boolean, default: true },
      installmentAdvisoryMaxMonths: { type: Number, default: 12 },
    },
    default: {
      minimumWageMonthly: null,
      minimumWageCategory: 'unskilled',
      deductionCapPercent: 50,
      installmentAdvisoryOneThirdEnabled: true,
      installmentAdvisoryMaxMonths: 12,
    },
  })
  compliance: {
    minimumWageMonthly: number | null;
    minimumWageCategory: 'unskilled' | 'semi_skilled' | 'skilled' | 'highly_skilled';
    deductionCapPercent: 50 | 75;
    installmentAdvisoryOneThirdEnabled: boolean;
    installmentAdvisoryMaxMonths: number;
  };

  /**
   * Employer-loan configuration.
   * sbiBenchmarkRate: SBI base lending rate used for perquisite valuation under
   *   IT Rule 3(7)(i). Defaulted to 8.65% for FY 2025-26 based on RBI/SBI
   *   published rate. MUST be confirmed with the workspace CA and updated
   *   annually on or after 1 April each FY. Admin-editable in PayrollConfig
   *   settings screen so no redeploy is required.
   * perquisiteExemptionThreshold: aggregate outstanding loan amount below which
   *   perquisite is exempt per FY (Rs 2,00,000 per Union Budget 2025,
   *   effective 1 April 2026). Admin-editable in case gazette notification
   *   differs from the budgeted figure.
   * maxActiveLoanAmount / maxActiveLoanCount: soft workspace limits (0 = no limit).
   * approvalChainDefault: cloned into each new loan's approvalChain if the
   *   creator does not supply an override.
   *
   * Self-apply (employee-originated LoanRequest layer, additive, ON by default per
   * owner directive 2026-06-22 — the 0% loan should be available without setup):
   * selfApplyEnabled: AND-gate for worker self-apply for a 0% loan. Defaults TRUE
   *   (schema default + the 0051 backfill for existing workspaces); an owner can
   *   still switch it off per workspace. Legacy docs predating the field read via
   *   .lean() as `undefined` (treated as off) until the 0051 backfill stamps true.
   * selfApplyMinTenureMonths: minimum employment tenure (months since join)
   *   required to self-apply; null = no minimum.
   * selfApplyMaxAmount: max requestedAmount in paise; null = no cap.
   */
  @Prop({
    type: {
      sbiBenchmarkRate: { type: Number, default: 8.65 },
      perquisiteExemptionThreshold: { type: Number, default: 200000 },
      maxActiveLoanAmount: { type: Number, default: 0 },
      maxActiveLoanCount: { type: Number, default: 0 },
      approvalChainDefault: {
        type: [
          {
            approverId: { type: Types.ObjectId, ref: 'User' },
            approverName: { type: String },
            _id: false,
          },
        ],
        default: [],
      },
      // Self-apply (LoanRequest layer) — additive, OFF by default so existing
      // tenants are unchanged. Links: loan-request.schema.ts, REQUEST_LOAN action.
      selfApplyEnabled: { type: Boolean, default: true },
      selfApplyMinTenureMonths: { type: Number, default: null, min: 0 },
      selfApplyMaxAmount: { type: Number, default: null, min: 1 },
    },
    default: {
      sbiBenchmarkRate: 8.65,
      perquisiteExemptionThreshold: 200000,
      maxActiveLoanAmount: 0,
      maxActiveLoanCount: 0,
      approvalChainDefault: [],
      selfApplyEnabled: true,
      selfApplyMinTenureMonths: null,
      selfApplyMaxAmount: null,
    },
  })
  loanConfig: {
    /** annual SBI benchmark rate percent for perquisite (IT Rule 3(7)(i)); update each 1 April */
    sbiBenchmarkRate: number;
    /** aggregate outstanding threshold below which perquisite is exempt (Rs); default Rs 2,00,000 */
    perquisiteExemptionThreshold: number;
    /** 0 = no limit; soft cap on total active loan amount per member */
    maxActiveLoanAmount: number;
    /** 0 = no limit; soft cap on concurrent active loan count per member */
    maxActiveLoanCount: number;
    /** workspace-default approval chain; cloned at loan creation (override per loan) */
    approvalChainDefault: Array<{
      approverId: Types.ObjectId;
      approverName: string;
    }>;
    /** AND-gate for the self-service loan request; ON by default (owner directive 2026-06-22). */
    selfApplyEnabled: boolean;
    /** Minimum tenure months (since join) required to self-apply; null = no minimum. */
    selfApplyMinTenureMonths?: number | null;
    /** Max self-apply requestedAmount in paise; null = no cap. */
    selfApplyMaxAmount?: number | null;
  };

  /**
   * Statutory Bonus configuration (Payment of Bonus Act / Code on Wages, India).
   *
   * CONFIRM ALL THRESHOLDS WITH YOUR CA BEFORE DISBURSAL.
   *
   * eligibilityWageCeiling: monthly wage ceiling for bonus eligibility.
   *   Statutory default Rs 21,000 (Notification S.O. 1420(E) 2015-16).
   *   CA confirms the current notified limit for each accounting year.
   *
   * calculationWageFloor: the minimum wage base used to compute bonus.
   *   Statutory default Rs 7,000 (Payment of Bonus Act s.12). When the
   *   workspace compliance.minimumWageMonthly is higher, the service uses
   *   max(calculationWageFloor, minimumWageMonthly) automatically.
   *
   * minPercent / maxPercent: statutory range (8.33% = 1/12 to 20%).
   *   Do not lower below 8.33 or raise above 20. Admin-editable for
   *   workspaces with CA-certified allocable surplus.
   *
   * defaultPercent: the percent used when allocableSurplusPercent is 0.
   *   Always 8.33 unless CA has certified a higher allocable surplus.
   *
   * allocableSurplusPercent: workspace-level allocable surplus percentage
   *   derived from annual accounts. 0 = use minimum 8.33%. Update each
   *   year after CA certification. CA confirmation required before changing.
   *
   * clawbackMonthsDefault: number of months after disbursal during which
   *   an employee exit triggers a clawback deduction in F&F.
   *   0 = clawback disabled. Recommended: 6 months (industry default).
   *
   * newEstablishment: when true, the statutory engine blocks disbursal
   *   with a notice (first 5 years exemption, Payment of Bonus Act s.16).
   *   Self-certified by workspace owner; CA confirmation recommended.
   */
  @Prop({
    type: {
      eligibilityWageCeiling: { type: Number, default: 21000 },
      calculationWageFloor: { type: Number, default: 7000 },
      minPercent: { type: Number, default: 8.33 },
      maxPercent: { type: Number, default: 20 },
      defaultPercent: { type: Number, default: 8.33 },
      allocableSurplusPercent: { type: Number, default: 0 },
      clawbackMonthsDefault: { type: Number, default: 0 },
      newEstablishment: { type: Boolean, default: false },
    },
    default: {
      eligibilityWageCeiling: 21000,
      calculationWageFloor: 7000,
      minPercent: 8.33,
      maxPercent: 20,
      defaultPercent: 8.33,
      allocableSurplusPercent: 0,
      clawbackMonthsDefault: 0,
      newEstablishment: false,
    },
  })
  bonusConfig: {
    /** Rs 21,000 default - CA confirms current notified ceiling */
    eligibilityWageCeiling: number;
    /** Rs 7,000 default - engine uses max(this, compliance.minimumWageMonthly) */
    calculationWageFloor: number;
    /** Minimum statutory percent (8.33 = 1/12); do not lower below 8.33 */
    minPercent: number;
    /** Maximum statutory percent (20); do not raise above 20 */
    maxPercent: number;
    /** Applied when allocableSurplusPercent=0; always 8.33 unless CA certified */
    defaultPercent: number;
    /** 0 = use minimum 8.33%; set after CA certification of annual surplus */
    allocableSurplusPercent: number;
    /** 0 = clawback disabled; 6 = 6-month window (industry default) */
    clawbackMonthsDefault: number;
    /** True = first-5-years exemption (Payment of Bonus Act s.16); CA confirms */
    newEstablishment: boolean;
  };

  @Prop({
    type: {
      tan: { type: String, default: '' },
      pan: { type: String, default: '' },
      branchDivision: { type: String, default: '' },
      address1: { type: String, default: '' },
      address2: { type: String, default: '' },
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      pincode: { type: String, default: '' },
      phone: { type: String, default: '' },
      email: { type: String, default: '' },
      responsiblePersonName: { type: String, default: '' },
      responsiblePersonPan: { type: String, default: '' },
      responsiblePersonDesignation: { type: String, default: '' },
    },
    default: {
      tan: '',
      pan: '',
      branchDivision: '',
      address1: '',
      address2: '',
      city: '',
      state: '',
      pincode: '',
      phone: '',
      email: '',
      responsiblePersonName: '',
      responsiblePersonPan: '',
      responsiblePersonDesignation: '',
    },
  })
  deductor: {
    tan: string;
    pan: string;
    branchDivision: string;
    address1: string;
    address2: string;
    city: string;
    state: string;
    pincode: string;
    phone: string;
    email: string;
    responsiblePersonName: string;
    responsiblePersonPan: string;
    responsiblePersonDesignation: string;
  };

  /**
   * Retention policy (Workstream G hardening, OQ-S4). Per-workspace override of
   * the statutory retention window used by the retention-purge cron. The cron
   * always clamps these UP to the env floor (payrollYears>=8, wageLedgerYears>=10)
   * so a workspace can keep records LONGER (contracts differ) but can never set
   * the window below the legal minimum. Absent on legacy docs → the cron falls
   * back to the env floor via `.lean()` + nullish coalescing (no migration needed).
   * See docs/compliance/DATA-MAP-AND-RETENTION.md §2.
   */
  @Prop({
    type: {
      payrollYears: { type: Number, default: 8, min: 8 },
      wageLedgerYears: { type: Number, default: 10, min: 10 },
    },
    default: { payrollYears: 8, wageLedgerYears: 10 },
    _id: false,
  })
  retention?: {
    /** salary/payroll/statutory/tax keep window in years (>=8 statutory floor) */
    payrollYears: number;
    /** Gujarat wage register + daily-wage cash ledger keep window (>=10 floor) */
    wageLedgerYears: number;
  };
}

export const PayrollConfigSchema = SchemaFactory.createForClass(PayrollConfig);
