/**
 * LWF rates per state - fixed statutory amounts.
 * Frequency: 'biannual' = June (6) + December (12)
 *            'annual'   = December (12) only
 *
 * Amounts as per latest state notifications.
 * Last verified: 2024.
 */
export interface LwfRate {
  state: string;
  employeeAmount: number;
  employerAmount: number;
  deductionMonths: number[];
}

export const LWF_RATES: LwfRate[] = [
  {
    state: 'Gujarat',
    employeeAmount: 3,
    employerAmount: 6,
    deductionMonths: [6, 12],
  },
  {
    state: 'Maharashtra',
    employeeAmount: 6,
    employerAmount: 12,
    deductionMonths: [6, 12],
  },
  {
    state: 'Karnataka',
    employeeAmount: 20,
    employerAmount: 40,
    deductionMonths: [6, 12],
  },
  {
    state: 'Telangana',
    employeeAmount: 2,
    employerAmount: 3,
    deductionMonths: [6, 12],
  },
  {
    state: 'Tamil Nadu',
    employeeAmount: 10,
    employerAmount: 20,
    deductionMonths: [6, 12],
  },
  {
    state: 'West Bengal',
    employeeAmount: 3,
    employerAmount: 15,
    deductionMonths: [12],
  },
  {
    state: 'Kerala',
    employeeAmount: 4,
    employerAmount: 8,
    deductionMonths: [6, 12],
  },
  {
    state: 'Madhya Pradesh',
    employeeAmount: 10,
    employerAmount: 35,
    deductionMonths: [6, 12],
  },
  {
    state: 'Andhra Pradesh',
    employeeAmount: 0,
    employerAmount: 0,
    deductionMonths: [],
  },
];

export function getLwfRate(state: string): LwfRate | null {
  if (!state) return null;

  const normalized = state.trim().toLowerCase();
  const rate = LWF_RATES.find(
    (item) =>
      item.state.toLowerCase() === normalized && item.employeeAmount > 0,
  );

  return rate || null;
}

export function isLwfDeductionMonth(state: string, month: number): boolean {
  const rate = getLwfRate(state);
  if (!rate) return false;
  return rate.deductionMonths.includes(month);
}
