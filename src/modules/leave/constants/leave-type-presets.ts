import type {
  LeaveTypeLabels,
  LeaveTypeUnit,
  LeaveStatutoryBasis,
  LeaveAccrualMode,
  LeaveAccrualFrequency,
  LeaveGenderApplicability,
} from '../schemas/leave-type.schema';

/**
 * India SMB leave-type preset — seeded on workspace creation and backfilled to
 * existing workspaces by migration. Meets or exceeds the Gujarat statutory
 * floors (Shops & Establishments Act 2019: 7 casual + 7 sick; Factories Act
 * 1948: earned leave at 1-per-20-days with a 63-day accumulation ceiling;
 * Maternity Benefit Act: 26 weeks). The owner edits or extends it afterward.
 *
 * Not industry-specific: leave entitlements are statutory, not textile-bound,
 * so one preset serves every workspace (unlike workspace designations). The
 * `gu-en` / `hi-en` labels equal `en` — leave-type names carry no distinct
 * Indian-English vocabulary, unlike Karigar-family designations.
 */
export interface LeaveTypePreset {
  code: string;
  labels: LeaveTypeLabels;
  color: string;
  isPaid: boolean;
  unit: LeaveTypeUnit;
  statutoryBasis: LeaveStatutoryBasis;
  maxPerRequest: number | null;
  applicability: {
    gender: LeaveGenderApplicability;
    minTenureDays: number | null;
  };
  accrualRule: {
    mode: LeaveAccrualMode;
    annualQuantity: number;
    rate: number | null;
    frequency: LeaveAccrualFrequency | null;
    proRateFirstPeriod: boolean;
    accrualCap: number | null;
    eligibleAfterDays: number;
  };
  yearEndRule: {
    carryForwardCap: number;
    lapseExcess: boolean;
    encashable: boolean;
    encashmentCap: number | null;
  };
  compOff: { isCompOff: boolean; validityDays: number };
  isSystem: boolean;
  sortOrder: number;
}

export const LEAVE_TYPE_PRESETS: LeaveTypePreset[] = [
  {
    code: 'CL',
    labels: {
      en: 'Casual Leave',
      'gu-en': 'Casual Leave',
      'hi-en': 'Casual Leave',
      gu: 'પરચૂરણ રજા',
    },
    color: '#1677ff',
    isPaid: true,
    unit: 'half_day_capable',
    statutoryBasis: 'shops_act',
    maxPerRequest: null,
    applicability: { gender: 'any', minTenureDays: null },
    accrualRule: {
      mode: 'upfront_annual',
      annualQuantity: 7,
      rate: null,
      frequency: null,
      proRateFirstPeriod: true,
      accrualCap: null,
      eligibleAfterDays: 0,
    },
    yearEndRule: {
      carryForwardCap: 0,
      lapseExcess: true,
      encashable: false,
      encashmentCap: null,
    },
    compOff: { isCompOff: false, validityDays: 90 },
    isSystem: false,
    sortOrder: 10,
  },
  {
    code: 'SL',
    labels: {
      en: 'Sick Leave',
      'gu-en': 'Sick Leave',
      'hi-en': 'Sick Leave',
      gu: 'માંદગી રજા',
    },
    color: '#13c2c2',
    isPaid: true,
    unit: 'half_day_capable',
    statutoryBasis: 'shops_act',
    maxPerRequest: null,
    applicability: { gender: 'any', minTenureDays: null },
    accrualRule: {
      mode: 'upfront_annual',
      annualQuantity: 7,
      rate: null,
      frequency: null,
      proRateFirstPeriod: true,
      accrualCap: null,
      eligibleAfterDays: 0,
    },
    yearEndRule: {
      carryForwardCap: 0,
      lapseExcess: true,
      encashable: false,
      encashmentCap: null,
    },
    compOff: { isCompOff: false, validityDays: 90 },
    isSystem: false,
    sortOrder: 20,
  },
  {
    code: 'EL',
    labels: {
      en: 'Earned Leave',
      'gu-en': 'Earned Leave',
      'hi-en': 'Earned Leave',
      gu: 'કમાયેલી રજા',
    },
    color: '#52c41a',
    isPaid: true,
    unit: 'half_day_capable',
    statutoryBasis: 'factories_act',
    maxPerRequest: null,
    applicability: { gender: 'any', minTenureDays: null },
    accrualRule: {
      mode: 'periodic_accrual',
      annualQuantity: 0,
      rate: 1.5,
      frequency: 'monthly',
      proRateFirstPeriod: true,
      accrualCap: 63,
      eligibleAfterDays: 90,
    },
    yearEndRule: {
      carryForwardCap: 63,
      lapseExcess: true,
      encashable: true,
      encashmentCap: null,
    },
    compOff: { isCompOff: false, validityDays: 90 },
    isSystem: false,
    sortOrder: 30,
  },
  {
    code: 'MAT',
    labels: {
      en: 'Maternity Leave',
      'gu-en': 'Maternity Leave',
      'hi-en': 'Maternity Leave',
      gu: 'પ્રસૂતિ રજા',
    },
    color: '#eb2f96',
    isPaid: true,
    unit: 'full_day',
    statutoryBasis: 'maternity_act',
    maxPerRequest: 182,
    applicability: { gender: 'female', minTenureDays: null },
    accrualRule: {
      mode: 'none',
      annualQuantity: 0,
      rate: null,
      frequency: null,
      proRateFirstPeriod: true,
      accrualCap: null,
      eligibleAfterDays: 0,
    },
    yearEndRule: {
      carryForwardCap: 0,
      lapseExcess: true,
      encashable: false,
      encashmentCap: null,
    },
    compOff: { isCompOff: false, validityDays: 90 },
    isSystem: false,
    sortOrder: 40,
  },
  {
    code: 'PAT',
    labels: {
      en: 'Paternity Leave',
      'gu-en': 'Paternity Leave',
      'hi-en': 'Paternity Leave',
      gu: 'પિતૃત્વ રજા',
    },
    color: '#722ed1',
    isPaid: true,
    unit: 'full_day',
    statutoryBasis: 'voluntary',
    maxPerRequest: 5,
    applicability: { gender: 'male', minTenureDays: null },
    accrualRule: {
      mode: 'none',
      annualQuantity: 0,
      rate: null,
      frequency: null,
      proRateFirstPeriod: true,
      accrualCap: null,
      eligibleAfterDays: 0,
    },
    yearEndRule: {
      carryForwardCap: 0,
      lapseExcess: true,
      encashable: false,
      encashmentCap: null,
    },
    compOff: { isCompOff: false, validityDays: 90 },
    isSystem: false,
    sortOrder: 50,
  },
  {
    code: 'BRV',
    labels: {
      en: 'Bereavement Leave',
      'gu-en': 'Bereavement Leave',
      'hi-en': 'Bereavement Leave',
      gu: 'શોક રજા',
    },
    color: '#8c8c8c',
    isPaid: true,
    unit: 'full_day',
    statutoryBasis: 'voluntary',
    maxPerRequest: 3,
    applicability: { gender: 'any', minTenureDays: null },
    accrualRule: {
      mode: 'none',
      annualQuantity: 0,
      rate: null,
      frequency: null,
      proRateFirstPeriod: true,
      accrualCap: null,
      eligibleAfterDays: 0,
    },
    yearEndRule: {
      carryForwardCap: 0,
      lapseExcess: true,
      encashable: false,
      encashmentCap: null,
    },
    compOff: { isCompOff: false, validityDays: 90 },
    isSystem: false,
    sortOrder: 60,
  },
  {
    code: 'COMP',
    labels: {
      en: 'Compensatory Off',
      'gu-en': 'Comp-Off',
      'hi-en': 'Comp-Off',
      gu: 'વળતર રજા',
    },
    color: '#fa8c16',
    isPaid: true,
    unit: 'half_day_capable',
    statutoryBasis: 'voluntary',
    maxPerRequest: null,
    applicability: { gender: 'any', minTenureDays: null },
    accrualRule: {
      mode: 'none',
      annualQuantity: 0,
      rate: null,
      frequency: null,
      proRateFirstPeriod: true,
      accrualCap: null,
      eligibleAfterDays: 0,
    },
    yearEndRule: {
      carryForwardCap: 0,
      lapseExcess: true,
      encashable: false,
      encashmentCap: null,
    },
    compOff: { isCompOff: true, validityDays: 90 },
    isSystem: false,
    sortOrder: 70,
  },
  {
    code: 'LWP',
    labels: {
      en: 'Loss of Pay',
      'gu-en': 'Loss of Pay',
      'hi-en': 'Loss of Pay',
      gu: 'પગાર વિનાની રજા',
    },
    color: '#f5222d',
    isPaid: false,
    unit: 'half_day_capable',
    statutoryBasis: 'voluntary',
    maxPerRequest: null,
    applicability: { gender: 'any', minTenureDays: null },
    accrualRule: {
      mode: 'none',
      annualQuantity: 0,
      rate: null,
      frequency: null,
      proRateFirstPeriod: true,
      accrualCap: null,
      eligibleAfterDays: 0,
    },
    yearEndRule: {
      carryForwardCap: 0,
      lapseExcess: true,
      encashable: false,
      encashmentCap: null,
    },
    compOff: { isCompOff: false, validityDays: 90 },
    isSystem: true,
    sortOrder: 80,
  },
];
