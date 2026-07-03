import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PayrollConfig } from './schemas/payroll-config.schema';
import { SalaryAdjustment } from './schemas/salary-adjustment.schema';
import { Salary } from './schemas/salary.schema';
import { TaxDeclaration } from './schemas/tax-declaration.schema';
import { TdsChallan } from './schemas/tds-challan.schema';
import { TdsService } from './tds.service';
import type {
  Form24QAnnexureII,
  Form24QData,
  Form24QEmployeeRecord,
} from './types/salary.types';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';

function getQuarter(month: number, fyStartMonth = 4): number {
  const offset = (month - fyStartMonth + 12) % 12;
  return Math.floor(offset / 3) + 1;
}

function getFinancialYear(
  month: number,
  year: number,
  fyStartMonth = 4,
): number {
  return month >= fyStartMonth ? year : year - 1;
}

function buildFinancialYearMonths(financialYear: number, fyStartMonth = 4) {
  return Array.from({ length: 12 }, (_, index) => {
    const month = ((fyStartMonth - 1 + index) % 12) + 1;
    const year = fyStartMonth + index > 12 ? financialYear + 1 : financialYear;
    return { month, year };
  });
}

@Injectable()
export class TdsChallanService {
  constructor(
    @InjectModel(TdsChallan.name)
    private readonly tdsChallanModel: Model<TdsChallan>,
    @InjectModel(PayrollConfig.name)
    private readonly payrollConfigModel: Model<PayrollConfig>,
    @InjectModel(TaxDeclaration.name)
    private readonly taxDeclarationModel: Model<TaxDeclaration>,
    @InjectModel(SalaryAdjustment.name)
    private readonly adjustmentModel: Model<SalaryAdjustment>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    @InjectModel(TeamMember.name)
    private readonly teamModel: Model<TeamMember>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly tdsService: TdsService,
  ) {}

  private async resolveFyStartMonth(workspaceId: string): Promise<number> {
    const workspace = await this.workspaceModel
      .findById(new Types.ObjectId(workspaceId))
      .select('fiscalYearStartMonth')
      .lean()
      .exec();

    return workspace?.fiscalYearStartMonth || 4;
  }

  async createChallan(
    workspaceId: string,
    dto: {
      month: number;
      year: number;
      bsrCode: string;
      bankName?: string;
      branchName?: string;
      challanSerialNo: string;
      depositDate: string;
      tdsTotalDeposited: number;
      interestAmount?: number;
      feeAmount?: number;
      remarks?: string;
    },
    userId: string,
  ): Promise<TdsChallan> {
    const fyStartMonth = await this.resolveFyStartMonth(workspaceId);
    const interestAmount = dto.interestAmount || 0;
    const feeAmount = dto.feeAmount || 0;

    return this.tdsChallanModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      quarter: getQuarter(dto.month, fyStartMonth),
      financialYear: getFinancialYear(dto.month, dto.year, fyStartMonth),
      month: dto.month,
      year: dto.year,
      bsrCode: dto.bsrCode.trim(),
      bankName: dto.bankName?.trim() || '',
      branchName: dto.branchName?.trim() || '',
      challanSerialNo: dto.challanSerialNo.trim(),
      depositDate: new Date(dto.depositDate),
      tdsTotalDeposited: dto.tdsTotalDeposited,
      interestAmount,
      feeAmount,
      totalChallanAmount: dto.tdsTotalDeposited + interestAmount + feeAmount,
      section: '192',
      minorHeadCode: '200',
      remarks: dto.remarks?.trim() || '',
      createdBy: new Types.ObjectId(userId),
    });
  }

  async updateChallan(
    workspaceId: string,
    challanId: string,
    dto: Partial<{
      month: number;
      year: number;
      bsrCode: string;
      bankName: string;
      branchName: string;
      challanSerialNo: string;
      depositDate: string;
      tdsTotalDeposited: number;
      interestAmount: number;
      feeAmount: number;
      remarks: string;
    }>,
    userId: string,
  ): Promise<TdsChallan> {
    const existing = await this.tdsChallanModel
      .findOne({
        _id: new Types.ObjectId(challanId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();

    if (!existing) {
      throw new NotFoundException('TDS challan not found');
    }

    const updates: Record<string, unknown> = {
      updatedBy: new Types.ObjectId(userId),
    };
    const fyStartMonth = await this.resolveFyStartMonth(workspaceId);

    if (dto.month !== undefined) updates.month = dto.month;
    if (dto.year !== undefined) updates.year = dto.year;
    if (dto.bsrCode !== undefined) updates.bsrCode = dto.bsrCode.trim();
    if (dto.bankName !== undefined) updates.bankName = dto.bankName.trim();
    if (dto.branchName !== undefined)
      updates.branchName = dto.branchName.trim();
    if (dto.challanSerialNo !== undefined) {
      updates.challanSerialNo = dto.challanSerialNo.trim();
    }
    if (dto.depositDate !== undefined)
      updates.depositDate = new Date(dto.depositDate);
    if (dto.remarks !== undefined) updates.remarks = dto.remarks.trim();
    if (dto.tdsTotalDeposited !== undefined) {
      updates.tdsTotalDeposited = dto.tdsTotalDeposited;
    }
    if (dto.interestAmount !== undefined)
      updates.interestAmount = dto.interestAmount;
    if (dto.feeAmount !== undefined) updates.feeAmount = dto.feeAmount;

    const nextTdsTotal = dto.tdsTotalDeposited ?? existing.tdsTotalDeposited;
    const nextInterest = dto.interestAmount ?? existing.interestAmount;
    const nextFee = dto.feeAmount ?? existing.feeAmount;
    const nextMonth = dto.month ?? existing.month;
    const nextYear = dto.year ?? existing.year;
    updates.quarter = getQuarter(nextMonth, fyStartMonth);
    updates.financialYear = getFinancialYear(nextMonth, nextYear, fyStartMonth);
    updates.totalChallanAmount = nextTdsTotal + nextInterest + nextFee;

    const updated = await this.tdsChallanModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(challanId),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        { $set: updates },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException('TDS challan not found');
    }

    return updated;
  }

  async deleteChallan(workspaceId: string, challanId: string): Promise<void> {
    await this.tdsChallanModel.findOneAndDelete({
      _id: new Types.ObjectId(challanId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
  }

  async getChallansForFy(
    workspaceId: string,
    financialYear: number,
  ): Promise<TdsChallan[]> {
    return this.tdsChallanModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        financialYear,
      })
      .sort({ year: 1, month: 1, createdAt: 1 })
      .exec();
  }

  async getChallansForQuarter(
    workspaceId: string,
    financialYear: number,
    quarter: number,
  ): Promise<TdsChallan[]> {
    return this.tdsChallanModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        financialYear,
        quarter,
      })
      .sort({ year: 1, month: 1, createdAt: 1 })
      .exec();
  }

  async getTdsLiabilityForMonth(
    workspaceId: string,
    month: number,
    year: number,
  ): Promise<{
    totalTdsDeducted: number;
    employeeCount: number;
    breakdown: Array<{
      employeeName: string;
      pan: string;
      tdsAmount: number;
    }>;
  }> {
    const workspaceObjectId = new Types.ObjectId(workspaceId);
    const salaryRecords = await this.salaryModel
      .find({ workspaceId: workspaceObjectId, month, year })
      .select('_id teamMemberId')
      .lean()
      .exec();

    if (salaryRecords.length === 0) {
      return {
        totalTdsDeducted: 0,
        employeeCount: 0,
        breakdown: [],
      };
    }

    const salaryIds = salaryRecords.map((record) => record._id);
    const tdsAdjustments = await this.adjustmentModel
      .find({
        workspaceId: workspaceObjectId,
        salaryId: { $in: salaryIds },
        category: 'tds_employee',
        source: 'system',
        status: 'active',
      })
      .select('teamMemberId amount')
      .lean()
      .exec();

    const tdsByMember = new Map<string, number>();
    for (const adjustment of tdsAdjustments) {
      const memberId = adjustment.teamMemberId.toString();
      tdsByMember.set(
        memberId,
        (tdsByMember.get(memberId) || 0) + adjustment.amount,
      );
    }

    const memberIds = Array.from(tdsByMember.keys()).map(
      (memberId) => new Types.ObjectId(memberId),
    );
    const members = await this.teamModel
      .find({ _id: { $in: memberIds } })
      .select('name pan')
      .lean()
      .exec();
    const memberMap = new Map(
      members.map((member) => [member._id.toString(), member]),
    );

    const breakdown = Array.from(tdsByMember.entries())
      .map(([memberId, tdsAmount]) => {
        const member = memberMap.get(memberId);
        return {
          employeeName: member?.name || 'Unknown',
          pan: member?.pan || 'Not provided',
          tdsAmount,
        };
      })
      .sort((left, right) =>
        left.employeeName.localeCompare(right.employeeName),
      );

    return {
      totalTdsDeducted: breakdown.reduce(
        (sum, entry) => sum + entry.tdsAmount,
        0,
      ),
      employeeCount: breakdown.length,
      breakdown,
    };
  }

  async getTdsQuarterlySummary(
    workspaceId: string,
    financialYear: number,
    quarter: number,
  ): Promise<{
    quarter: number;
    financialYear: number;
    fyLabel: string;
    quarterLabel: string;
    quarterMonths: Array<{ month: number; year: number }>;
    totalTdsDeducted: number;
    totalChallanDeposited: number;
    difference: number;
    challans: TdsChallan[];
    employeeSummary: Array<{
      teamMemberId: string;
      employeeName: string;
      pan: string;
      grossSalary: number;
      tdsDeducted: number;
    }>;
  }> {
    const fyStartMonth = await this.resolveFyStartMonth(workspaceId);
    const workspaceObjectId = new Types.ObjectId(workspaceId);
    const quarterMonths: Array<{ month: number; year: number }> = [];
    const quarterStartOffset = (quarter - 1) * 3;

    for (let index = 0; index < 3; index += 1) {
      const offset = quarterStartOffset + index;
      quarterMonths.push({
        month: ((fyStartMonth - 1 + offset) % 12) + 1,
        year: fyStartMonth + offset > 12 ? financialYear + 1 : financialYear,
      });
    }

    const monthLabels = [
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
    const quarterLabel = `Q${quarter} (${monthLabels[quarterMonths[0].month - 1]}-${monthLabels[quarterMonths[2].month - 1]} ${quarterMonths[0].year !== quarterMonths[2].year ? `${quarterMonths[0].year}/${quarterMonths[2].year}` : quarterMonths[0].year})`;

    const challans = await this.getChallansForQuarter(
      workspaceId,
      financialYear,
      quarter,
    );
    const totalChallanDeposited = challans.reduce(
      (sum, challan) => sum + challan.tdsTotalDeposited,
      0,
    );

    const salaryRecords = await this.salaryModel
      .find({
        workspaceId: workspaceObjectId,
        $or: quarterMonths,
      })
      .select('_id teamMemberId baseSalary additions')
      .lean()
      .exec();

    if (salaryRecords.length === 0) {
      return {
        quarter,
        financialYear,
        fyLabel: `${financialYear}-${String(financialYear + 1).slice(2)}`,
        quarterLabel,
        quarterMonths,
        totalTdsDeducted: 0,
        totalChallanDeposited,
        difference: -totalChallanDeposited,
        challans,
        employeeSummary: [],
      };
    }

    const salaryIds = salaryRecords.map((record) => record._id);
    const tdsAdjustments = await this.adjustmentModel
      .find({
        workspaceId: workspaceObjectId,
        salaryId: { $in: salaryIds },
        category: 'tds_employee',
        source: 'system',
        status: 'active',
      })
      .select('salaryId amount')
      .lean()
      .exec();

    const tdsBySalaryId = new Map<string, number>();
    for (const adjustment of tdsAdjustments) {
      const salaryId = adjustment.salaryId.toString();
      tdsBySalaryId.set(
        salaryId,
        (tdsBySalaryId.get(salaryId) || 0) + adjustment.amount,
      );
    }

    const memberIds = Array.from(
      new Set(salaryRecords.map((record) => record.teamMemberId.toString())),
    ).map((memberId) => new Types.ObjectId(memberId));
    const members = await this.teamModel
      .find({ _id: { $in: memberIds } })
      .select('name pan')
      .lean()
      .exec();
    const memberMap = new Map(
      members.map((member) => [member._id.toString(), member]),
    );

    const employeeSummaryMap = new Map<
      string,
      {
        teamMemberId: string;
        employeeName: string;
        pan: string;
        grossSalary: number;
        tdsDeducted: number;
      }
    >();

    for (const salaryRecord of salaryRecords) {
      const memberId = salaryRecord.teamMemberId.toString();
      const member = memberMap.get(memberId);
      const existingEntry = employeeSummaryMap.get(memberId) || {
        teamMemberId: memberId,
        employeeName: member?.name || 'Unknown',
        pan: member?.pan || '',
        grossSalary: 0,
        tdsDeducted: 0,
      };

      existingEntry.grossSalary +=
        (salaryRecord.baseSalary || 0) + (salaryRecord.additions || 0);
      existingEntry.tdsDeducted +=
        tdsBySalaryId.get(salaryRecord._id.toString()) || 0;
      employeeSummaryMap.set(memberId, existingEntry);
    }

    const employeeSummary = Array.from(employeeSummaryMap.values()).sort(
      (left, right) => left.employeeName.localeCompare(right.employeeName),
    );
    const totalTdsDeducted = employeeSummary.reduce(
      (sum, employee) => sum + employee.tdsDeducted,
      0,
    );

    return {
      quarter,
      financialYear,
      fyLabel: `${financialYear}-${String(financialYear + 1).slice(2)}`,
      quarterLabel,
      quarterMonths,
      totalTdsDeducted,
      totalChallanDeposited,
      difference: totalTdsDeducted - totalChallanDeposited,
      challans,
      employeeSummary,
    };
  }

  async getForm24QData(
    workspaceId: string,
    financialYear: number,
    quarter: number,
    fyStartMonth = 4,
  ): Promise<Form24QData> {
    const workspaceObjectId = new Types.ObjectId(workspaceId);
    const workspace = await this.workspaceModel
      .findById(workspaceObjectId)
      .select('name fiscalYearStartMonth')
      .lean()
      .exec();

    const resolvedFyStartMonth =
      workspace?.fiscalYearStartMonth || fyStartMonth;
    const summary = await this.getTdsQuarterlySummary(
      workspaceId,
      financialYear,
      quarter,
    );
    const config = await this.payrollConfigModel
      .findOne({ workspaceId: workspaceObjectId })
      .select('deductor')
      .lean()
      .exec();
    const isQ4 = quarter === 4;
    const memberIds = summary.employeeSummary.map(
      (employee) => new Types.ObjectId(employee.teamMemberId),
    );

    const [declarations, members] = await Promise.all([
      memberIds.length
        ? this.taxDeclarationModel
            .find({
              workspaceId: workspaceObjectId,
              teamMemberId: { $in: memberIds },
              financialYear,
            })
            .lean()
            .exec()
        : Promise.resolve([]),
      memberIds.length
        ? this.teamModel
            .find({ _id: { $in: memberIds } })
            .select('name pan taxRegime dateOfJoining employmentType')
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);

    const declarationMap = new Map(
      declarations.map((declaration) => [
        declaration.teamMemberId.toString(),
        declaration,
      ]),
    );
    const memberMap = new Map(
      members.map((member) => [member._id.toString(), member]),
    );
    const annualByMember = new Map<
      string,
      { grossSalary: number; totalTdsDeducted: number }
    >();

    if (isQ4 && memberIds.length) {
      const financialYearMonths = buildFinancialYearMonths(
        financialYear,
        resolvedFyStartMonth,
      );
      const annualSalaryRecords = (await this.salaryModel
        .find({
          workspaceId: workspaceObjectId,
          teamMemberId: { $in: memberIds },
          $or: financialYearMonths,
        })
        .select('_id teamMemberId baseSalary additions')
        .lean()
        .exec()) as Array<{
        _id: Types.ObjectId;
        teamMemberId: Types.ObjectId;
        baseSalary?: number;
        additions?: number;
      }>;

      const salaryIds = annualSalaryRecords.map((record) => record._id);
      const annualTdsAdjustments = salaryIds.length
        ? await this.adjustmentModel
            .find({
              workspaceId: workspaceObjectId,
              salaryId: { $in: salaryIds },
              category: 'tds_employee',
              source: 'system',
              status: 'active',
            })
            .select('salaryId amount')
            .lean()
            .exec()
        : [];

      const tdsBySalaryId = new Map<string, number>();
      for (const adjustment of annualTdsAdjustments) {
        const salaryId = adjustment.salaryId.toString();
        tdsBySalaryId.set(
          salaryId,
          (tdsBySalaryId.get(salaryId) || 0) + adjustment.amount,
        );
      }

      for (const record of annualSalaryRecords) {
        const memberId = record.teamMemberId.toString();
        const existing = annualByMember.get(memberId) || {
          grossSalary: 0,
          totalTdsDeducted: 0,
        };

        existing.grossSalary +=
          (record.baseSalary || 0) + (record.additions || 0);
        existing.totalTdsDeducted +=
          tdsBySalaryId.get(record._id.toString()) || 0;
        annualByMember.set(memberId, existing);
      }
    }

    const employees: Form24QEmployeeRecord[] = summary.employeeSummary.map(
      (employee, index) => {
        const member = memberMap.get(employee.teamMemberId);
        const declaration = declarationMap.get(employee.teamMemberId);
        const regime: 'old' | 'new' =
          declaration?.taxRegime || member?.taxRegime || 'new';
        let annexureII: Form24QAnnexureII | null = null;

        if (isQ4) {
          const annualGrossSalary =
            annualByMember.get(employee.teamMemberId)?.grossSalary ||
            employee.grossSalary;
          const annualTdsDeducted =
            annualByMember.get(employee.teamMemberId)?.totalTdsDeducted ||
            employee.tdsDeducted;
          const standardDeduction = regime === 'old' ? 50000 : 75000;
          const hraExemption = declaration?.hraExemption || 0;
          const previousEmployerGross = declaration?.previousEmployerGross || 0;
          const previousEmployerTds = declaration?.previousEmployerTds || 0;
          let netTaxableIncome = Math.max(
            annualGrossSalary +
              previousEmployerGross -
              standardDeduction -
              hraExemption,
            0,
          );

          if (regime === 'old') {
            const viADeductions =
              Math.min(declaration?.deduction80C || 0, 150000) +
              (declaration?.deduction80D || 0) +
              (declaration?.deduction80G || 0) +
              Math.min(declaration?.deduction80CCD1B || 0, 50000) +
              Math.min(declaration?.deduction80TTA || 0, 10000) +
              (declaration?.otherDeductions || 0);
            netTaxableIncome = Math.max(netTaxableIncome - viADeductions, 0);
          }

          annexureII = {
            grossSalary: annualGrossSalary,
            standardDeduction,
            hraExemption,
            deduction80C: declaration?.deduction80C || 0,
            deduction80D: declaration?.deduction80D || 0,
            deduction80G: declaration?.deduction80G || 0,
            deduction80CCD1B: declaration?.deduction80CCD1B || 0,
            deduction80TTA: declaration?.deduction80TTA || 0,
            otherDeductions: declaration?.otherDeductions || 0,
            taxRegime: regime,
            netTaxableIncome,
            taxLiability:
              regime === 'new'
                ? this.tdsService.computeTaxNewRegime(netTaxableIncome)
                : this.tdsService.computeTaxOldRegime(netTaxableIncome),
            totalTdsDeducted: annualTdsDeducted,
            previousEmployerGross,
            previousEmployerTds,
          };
        }

        return {
          srNo: index + 1,
          pan: member?.pan?.trim() || 'PANNOTAVBL',
          name: member?.name || employee.employeeName || '',
          grossSalary: employee.grossSalary,
          tdsDeducted: employee.tdsDeducted,
          taxRegime: regime,
          annexureII,
        };
      },
    );

    const deductor = {
      tan: '',
      pan: '',
      name: workspace?.name || '',
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
      ...(config?.deductor || {}),
      name: workspace?.name || '',
    };

    return {
      deductor,
      financialYear,
      quarter,
      fyLabel: summary.fyLabel,
      quarterLabel: summary.quarterLabel,
      challans: summary.challans,
      employees,
      totalTdsDeducted: summary.totalTdsDeducted,
      totalChallanDeposited: summary.totalChallanDeposited,
      isQ4,
    };
  }
}
