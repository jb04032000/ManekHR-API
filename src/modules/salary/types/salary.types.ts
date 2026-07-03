import { Salary } from '../schemas/salary.schema';
import { Payment } from '../schemas/payment.schema';
import type { TdsChallan } from '../schemas/tds-challan.schema';

export interface SalaryResult {
  salary: Salary;
}

export interface PaymentResult {
  payment: Payment;
}

export interface Form24QAnnexureII {
  grossSalary: number;
  standardDeduction: number;
  hraExemption: number;
  deduction80C: number;
  deduction80D: number;
  deduction80G: number;
  deduction80CCD1B: number;
  deduction80TTA: number;
  otherDeductions: number;
  taxRegime: 'old' | 'new';
  netTaxableIncome: number;
  taxLiability: number;
  totalTdsDeducted: number;
  previousEmployerGross: number;
  previousEmployerTds: number;
}

export interface Form24QEmployeeRecord {
  srNo: number;
  pan: string;
  name: string;
  grossSalary: number;
  tdsDeducted: number;
  taxRegime: 'old' | 'new';
  annexureII: Form24QAnnexureII | null;
}

export interface Form24QDeductor {
  tan: string;
  pan: string;
  name: string;
  branchDivision?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  responsiblePersonName: string;
  responsiblePersonPan: string;
  responsiblePersonDesignation: string;
}

export interface Form24QData {
  deductor: Form24QDeductor;
  financialYear: number;
  quarter: number;
  fyLabel: string;
  quarterLabel: string;
  challans: TdsChallan[];
  employees: Form24QEmployeeRecord[];
  totalTdsDeducted: number;
  totalChallanDeposited: number;
  isQ4: boolean;
}
