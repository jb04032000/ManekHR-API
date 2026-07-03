import { Injectable } from '@nestjs/common';

export interface EcrRow {
  uan: string;
  memberName: string;
  grossWages: number;
  epfWages: number;
  epsWages: number;
  edliWages: number;
  epfContribution: number;
  epsContribution: number;
  epfDiff: number;
  ncp: number;
  refundOfAdvances: number;
}

export interface EsiRow {
  esicIpNumber: string;
  employeeName: string;
  grossSalary: number;
  employeeContribution: number;
  employerContribution: number;
  totalContribution: number;
  reasonCode: string;
}

export interface BankDisbursementRow {
  srNo: number;
  employeeName: string;
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  bankName: string;
  amount: number;
  paymentMode: 'NEFT' | 'RTGS';
  remarks: string;
  upiId?: string;
  preferredMethod: 'BANK' | 'UPI' | 'CASH' | 'UNKNOWN';
}

export interface BankFileResult {
  bankRows: BankDisbursementRow[];
  upiRows: BankDisbursementRow[];
  skippedRows: Array<{
    employeeName: string;
    reason: string;
  }>;
  totalAmount: number;
  totalEmployees: number;
}

type ComplianceBankDetails = {
  accountHolderName?: string;
  accountNumber?: string;
  ifscCode?: string;
  bankName?: string;
};

type ComplianceUpiDetails = {
  upiId?: string;
};

type ComplianceMember = {
  name?: string;
  uan?: string;
  esiIpNumber?: string;
  employmentType?: string;
  pfApplicable?: boolean;
  pfOptedOut?: boolean;
  esiApplicable?: boolean;
  preferredMethod?: string;
  bankDetails?: ComplianceBankDetails | null;
  upiDetails?: ComplianceUpiDetails | null;
};

type ComplianceSalaryRecord = {
  baseSalary?: number;
  additions?: number;
  totalDays?: number;
  presentDays?: number;
  pieceRateEarnings?: number;
  teamMember?: ComplianceMember | null;
  teamMemberId?: ComplianceMember | string | null;
};

@Injectable()
export class ComplianceExportService {
  private getMember(record: ComplianceSalaryRecord): ComplianceMember | null {
    if (record.teamMember && typeof record.teamMember === 'object') {
      return record.teamMember;
    }

    if (record.teamMemberId && typeof record.teamMemberId === 'object') {
      return record.teamMemberId;
    }

    return null;
  }

  private isPfApplicable(member: ComplianceMember): boolean {
    return (
      member.pfApplicable !== false &&
      member.pfOptedOut !== true &&
      !['contract', 'consultant', 'intern'].includes(
        member.employmentType || 'full_time',
      )
    );
  }

  private isEsiApplicable(
    member: ComplianceMember,
    grossSalary: number,
    esiGrossThreshold: number,
  ): boolean {
    return (
      !['contract', 'consultant'].includes(
        member.employmentType || 'full_time',
      ) &&
      (member.esiApplicable === true || grossSalary <= esiGrossThreshold)
    );
  }

  private normalizePreferredMethod(
    preferredMethod?: string,
  ): BankDisbursementRow['preferredMethod'] {
    if (
      preferredMethod === 'BANK' ||
      preferredMethod === 'UPI' ||
      preferredMethod === 'CASH'
    ) {
      return preferredMethod;
    }

    if (!preferredMethod) {
      return 'BANK';
    }

    return 'UNKNOWN';
  }

  async buildEcrData(
    workspaceId: string,
    month: number,
    year: number,
    salaryRecords: ComplianceSalaryRecord[],
    pfWageCeiling: number,
  ): Promise<EcrRow[]> {
    void workspaceId;
    void month;
    void year;

    const rows: EcrRow[] = [];

    for (const record of salaryRecords) {
      const member = this.getMember(record);
      if (!member || !this.isPfApplicable(member)) {
        continue;
      }

      if (!member.uan?.trim()) {
        continue;
      }

      // Phase 23 (D-09): include piece-rate earnings in PF gross wages
      const piecePortion = Number((record as any).pieceRateEarnings || 0);
      const grossWages = Number(record.baseSalary || 0) + piecePortion;
      const pfWages = Math.min(grossWages, pfWageCeiling);
      const epfContrib = Math.round(pfWages * 0.12);
      const epsContrib = Math.min(Math.round(pfWages * 0.0833), 1250);
      const epfDiff = epfContrib - epsContrib;
      const ncpDays = Math.max(
        Number(record.totalDays || 0) - Number(record.presentDays || 0),
        0,
      );

      rows.push({
        uan: member.uan.trim(),
        memberName: (member.name || '').toUpperCase().trim(),
        grossWages,
        epfWages: pfWages,
        epsWages: pfWages,
        edliWages: pfWages,
        epfContribution: epfContrib,
        epsContribution: epsContrib,
        epfDiff,
        ncp: ncpDays,
        refundOfAdvances: 0,
      });
    }

    return rows;
  }

  formatEcrText(
    rows: EcrRow[],
    establishmentName: string,
    establishmentCode: string,
    month: number,
    year: number,
  ): string {
    const monthStr = String(month).padStart(2, '0');
    const monthYear = `${monthStr}/${year}`;
    const lines: string[] = [];

    lines.push('#~#');
    lines.push(`${establishmentName}~${establishmentCode}~${monthYear}~INR`);

    for (const row of rows) {
      lines.push(
        [
          row.uan,
          row.memberName,
          row.grossWages,
          row.epfWages,
          row.epsWages,
          row.edliWages,
          row.epfContribution,
          row.epsContribution,
          row.epfDiff,
          row.ncp,
          row.refundOfAdvances,
        ].join('#'),
      );
    }

    return lines.join('\n');
  }

  async buildEsiData(
    workspaceId: string,
    month: number,
    year: number,
    salaryRecords: ComplianceSalaryRecord[],
    esiGrossThreshold: number,
  ): Promise<EsiRow[]> {
    void workspaceId;
    void month;
    void year;

    const rows: EsiRow[] = [];

    for (const record of salaryRecords) {
      const member = this.getMember(record);
      if (!member) {
        continue;
      }

      // Phase 23 (D-09): include piece-rate earnings in ESI gross salary
      const piecePortion = Number((record as any).pieceRateEarnings || 0);
      const grossSalary =
        Number(record.baseSalary || 0) + piecePortion + Number(record.additions || 0);
      if (!this.isEsiApplicable(member, grossSalary, esiGrossThreshold)) {
        continue;
      }

      const employeeContrib = Math.round(grossSalary * 0.0075);
      const employerContrib = Math.round(grossSalary * 0.0325);

      rows.push({
        esicIpNumber: member.esiIpNumber?.trim() || 'NOT_ASSIGNED',
        employeeName: (member.name || '').toUpperCase().trim(),
        grossSalary,
        employeeContribution: employeeContrib,
        employerContribution: employerContrib,
        totalContribution: employeeContrib + employerContrib,
        reasonCode: '01',
      });
    }

    return rows;
  }

  formatEsiCsv(rows: EsiRow[], month: number, year: number): string {
    const monthStr = String(month).padStart(2, '0');
    const header = [
      'IP Number',
      'Employee Name',
      'Gross Salary',
      'Employee Contribution (0.75%)',
      'Employer Contribution (3.25%)',
      'Total Contribution',
      'Reason Code',
    ].join(',');

    const dataLines = rows.map((row) =>
      [
        row.esicIpNumber,
        `"${row.employeeName}"`,
        row.grossSalary,
        row.employeeContribution,
        row.employerContribution,
        row.totalContribution,
        row.reasonCode,
      ].join(','),
    );

    const totalEmployeeContribution = rows.reduce(
      (sum, row) => sum + row.employeeContribution,
      0,
    );
    const totalEmployerContribution = rows.reduce(
      (sum, row) => sum + row.employerContribution,
      0,
    );
    const totalContribution = rows.reduce(
      (sum, row) => sum + row.totalContribution,
      0,
    );

    const summary = [
      '',
      `Total Employees,${rows.length}`,
      `Total Employee Contribution,${totalEmployeeContribution}`,
      `Total Employer Contribution,${totalEmployerContribution}`,
      `Total Contribution,${totalContribution}`,
      `Period,${monthStr}/${year}`,
    ];

    return [header, ...dataLines, ...summary].join('\n');
  }

  async buildBankDisbursementData(
    salaryRecords: ComplianceSalaryRecord[],
    month: number,
    year: number,
  ): Promise<BankFileResult> {
    const MONTHS = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const monthLabel = MONTHS[month - 1] || String(month);

    const bankRows: BankDisbursementRow[] = [];
    const upiRows: BankDisbursementRow[] = [];
    const skippedRows: BankFileResult['skippedRows'] = [];
    let srNo = 1;

    for (const record of salaryRecords) {
      const member = this.getMember(record);
      if (!member) {
        continue;
      }

      const amountDue = Math.max(
        Number((record as { netSalary?: number }).netSalary || 0) -
          Number((record as { paidAmount?: number }).paidAmount || 0),
        0,
      );

      if (amountDue <= 0) {
        continue;
      }

      const preferredMethod = this.normalizePreferredMethod(
        member.preferredMethod,
      );
      const employeeName = (member.name || '').trim();
      const remarks = `Salary ${monthLabel} ${year} - ${employeeName}`;

      if (preferredMethod === 'CASH') {
        skippedRows.push({
          employeeName,
          reason: 'Preferred payment method is CASH',
        });
        continue;
      }

      if (preferredMethod === 'UPI') {
        const upiId = member.upiDetails?.upiId?.trim();
        if (!upiId) {
          skippedRows.push({
            employeeName,
            reason: 'UPI ID not configured',
          });
          continue;
        }

        upiRows.push({
          srNo: srNo++,
          employeeName,
          accountHolderName: employeeName,
          accountNumber: '',
          ifscCode: '',
          bankName: '',
          amount: amountDue,
          paymentMode: 'NEFT',
          remarks,
          upiId,
          preferredMethod,
        });
        continue;
      }

      if (preferredMethod === 'UNKNOWN') {
        skippedRows.push({
          employeeName,
          reason: 'Preferred payment method is not configured',
        });
        continue;
      }

      const bankDetails = member.bankDetails;
      const accountNumber = bankDetails?.accountNumber?.trim();
      const ifscCode = bankDetails?.ifscCode?.trim();

      if (accountNumber && ifscCode) {
        bankRows.push({
          srNo: srNo++,
          employeeName,
          accountHolderName:
            bankDetails?.accountHolderName?.trim() || employeeName,
          accountNumber,
          ifscCode,
          bankName: bankDetails?.bankName?.trim() || '',
          amount: amountDue,
          paymentMode: amountDue >= 200000 ? 'RTGS' : 'NEFT',
          remarks,
          preferredMethod: 'BANK',
        });
        continue;
      }

      skippedRows.push({
        employeeName,
        reason: 'Bank account details not configured',
      });
    }

    const totalAmount = [...bankRows, ...upiRows].reduce(
      (sum, row) => sum + row.amount,
      0,
    );

    return {
      bankRows,
      upiRows,
      skippedRows,
      totalAmount,
      totalEmployees: bankRows.length + upiRows.length,
    };
  }

  formatBankNeftCsv(
    rows: BankDisbursementRow[],
    month: number,
    year: number,
    workspaceName: string,
  ): string {
    const MONTHS = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];

    const header = [
      'Sr No',
      'Beneficiary Name',
      'Account Number',
      'IFSC Code',
      'Bank Name',
      'Amount (INR)',
      'Payment Mode',
      'Remarks',
    ].join(',');

    const dataLines = rows.map((row) =>
      [
        row.srNo,
        `"${row.accountHolderName}"`,
        row.accountNumber,
        row.ifscCode,
        `"${row.bankName}"`,
        row.amount,
        row.paymentMode,
        `"${row.remarks}"`,
      ].join(','),
    );

    const summary = [
      '',
      `Employer,${workspaceName}`,
      `Salary Month,${MONTHS[month - 1]} ${year}`,
      `Total Employees,${rows.length}`,
      `Total Amount,${rows.reduce((sum, row) => sum + row.amount, 0)}`,
      `NEFT Count,${rows.filter((row) => row.paymentMode === 'NEFT').length}`,
      `RTGS Count,${rows.filter((row) => row.paymentMode === 'RTGS').length}`,
      `Generated On,${new Date().toLocaleDateString('en-IN')}`,
    ];

    return [header, ...dataLines, ...summary].join('\n');
  }

  formatUpiCsv(
    rows: BankDisbursementRow[],
    month: number,
    year: number,
    workspaceName: string,
  ): string {
    const MONTHS = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];

    const header = [
      'Sr No',
      'Employee Name',
      'UPI ID',
      'Amount (INR)',
      'Remarks',
    ].join(',');

    const dataLines = rows.map((row) =>
      [
        row.srNo,
        `"${row.employeeName}"`,
        row.upiId || '',
        row.amount,
        `"${row.remarks}"`,
      ].join(','),
    );

    const summary = [
      '',
      `Employer,${workspaceName}`,
      `Salary Month,${MONTHS[month - 1]} ${year}`,
      `Total UPI Payments,${rows.length}`,
      `Total Amount,${rows.reduce((sum, row) => sum + row.amount, 0)}`,
    ];

    return [header, ...dataLines, ...summary].join('\n');
  }
}
