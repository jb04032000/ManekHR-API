import { Types } from 'mongoose';

export interface StatutoryMeta {
  workspaceId: string;
  workspaceName: string;
  workspaceAddress?: string;
  from: string;              // 'YYYY-MM-DD' inclusive
  to: string;                // 'YYYY-MM-DD' inclusive
  generatedAt: Date;
  generatedByName?: string;
}

export interface AttendanceDailyRow {
  date: string;              // 'YYYY-MM-DD'
  status: string;            // present|absent|half_day|late|on_leave|holiday|week_off
  checkIn: Date | null;
  checkOut: Date | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  otMinutes: number | null;
  computeReason: string | null;
}

export interface AttendanceSummaryRow {
  memberId: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  days: AttendanceDailyRow[];     // one per calendar day in range
  totalPresentDays: number;
  totalAbsentDays: number;
  totalLateDays: number;
  totalHalfDays: number;
  totalOtMinutes: number;
  totalWorkedMinutes: number;
}

export interface OtSummaryRowDay {
  date: string;
  otMinutes: number;
  dailyRate: number;              // resolved via OT cascade
  otAmount: number;               // dailyRate * 2 * (otMinutes / 60 / 8)  [per Factories Act §59]
  rateSource: 'salary_ledger' | 'ctc_amount' | 'custom_override';
}

export interface OtSummaryRow {
  memberId: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  days: OtSummaryRowDay[];        // only days with otMinutes > 0
  totalOtMinutes: number;
  totalOtAmount: number;
}

export interface LopDayRow {
  date: string;
  status: string;
  shiftDurationMinutes: number;
  workedMinutes: number | null;
  lopMinutes: number;
  computeReason: string | null;
}

export interface LopSummaryRow {
  memberId: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  days: LopDayRow[];              // only days with lopMinutes > 0
  totalLopMinutes: number;
  totalLopDays: number;
  baseSalary: number | null;      // null if no salary ledger
  deductionAmount: number | null; // null if baseSalary null
}

export interface PfEsiWageRow {
  memberId: string;
  name: string;
  employeeCode: string | null;
  uan: string | null;
  esiIpNumber: string | null;
  grossWages: number;
  // PF columns
  epfWages: number;
  epsWages: number;
  edliWages: number;
  employeeEpfContribution: number;  // 12% of epfWages
  employerEpsContribution: number;  // min(8.33% of epsWages, 1250)
  employerEpfDifference: number;    // employeeEpfContribution - employerEpsContribution
  ncpDays: number;
  refundOfAdvances: number;
  // ESI columns
  employeeEsiContribution: number;  // 0.75% of grossWages when applicable
  employerEsiContribution: number;  // 3.25% of grossWages when applicable
  esiApplicable: boolean;
}

export type StatutoryFormat = 'pdf' | 'xlsx';

export interface StatutoryBuildResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;          // 'application/pdf' or 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}
