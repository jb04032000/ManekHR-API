import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TaxDeclaration } from './schemas/tax-declaration.schema';
import { UpsertTaxDeclarationDto } from './dto/salary.dto';

@Injectable()
export class TdsService {
  constructor(
    @InjectModel(TaxDeclaration.name)
    private taxDeclarationModel: Model<TaxDeclaration>,
  ) {}

  getFinancialYear(month: number, year: number, fyStartMonth = 4): number {
    return month >= fyStartMonth ? year : year - 1;
  }

  getEffectiveMonthsInFy(
    payrollMonth: number,
    payrollYear: number,
    joinMonth: number | null,
    joinYear: number | null,
    fyStartMonth = 4,
  ): { totalFyMonths: number; monthsElapsed: number; monthsRemaining: number } {
    const fyYear = this.getFinancialYear(payrollMonth, payrollYear, fyStartMonth);
    const fyStart = { month: fyStartMonth, year: fyYear };
    const fyEnd = {
      month: fyStartMonth === 1 ? 12 : fyStartMonth - 1,
      year: fyStartMonth === 1 ? fyYear : fyYear + 1,
    };

    let effectiveStart = fyStart;
    if (joinMonth !== null && joinYear !== null) {
      const joinedAfterFyStart =
        joinYear > fyStart.year || (joinYear === fyStart.year && joinMonth > fyStart.month);

      if (joinedAfterFyStart) {
        effectiveStart = { month: joinMonth, year: joinYear };
      }
    }

    const totalFyMonths =
      (fyEnd.year - effectiveStart.year) * 12 + (fyEnd.month - effectiveStart.month) + 1;
    const monthsElapsed =
      (payrollYear - effectiveStart.year) * 12 + (payrollMonth - effectiveStart.month) + 1;
    const monthsRemaining = Math.max(totalFyMonths - monthsElapsed, 1);

    return {
      totalFyMonths: Math.max(totalFyMonths, 1),
      monthsElapsed: Math.max(monthsElapsed, 1),
      monthsRemaining,
    };
  }

  getFyMonthRange(
    fyYear: number,
    fyStartMonth = 4,
  ): Array<{ 'salary.month': number; 'salary.year': number }> {
    const range: Array<{ 'salary.month': number; 'salary.year': number }> = [];

    for (let i = 0; i < 12; i += 1) {
      const month = ((fyStartMonth - 1 + i) % 12) + 1;
      const year = fyStartMonth + i > 12 ? fyYear + 1 : fyYear;
      range.push({ 'salary.month': month, 'salary.year': year });
    }

    return range;
  }

  computeTaxNewRegime(annualTaxableIncome: number): number {
    let tax = 0;

    if (annualTaxableIncome <= 300000) tax = 0;
    else if (annualTaxableIncome <= 700000) tax = (annualTaxableIncome - 300000) * 0.05;
    else if (annualTaxableIncome <= 1000000) tax = 20000 + (annualTaxableIncome - 700000) * 0.1;
    else if (annualTaxableIncome <= 1200000) tax = 50000 + (annualTaxableIncome - 1000000) * 0.15;
    else if (annualTaxableIncome <= 1500000) tax = 80000 + (annualTaxableIncome - 1200000) * 0.2;
    else tax = 140000 + (annualTaxableIncome - 1500000) * 0.3;

    if (annualTaxableIncome > 10000000) tax *= 1.15;
    else if (annualTaxableIncome > 5000000) tax *= 1.1;

    tax *= 1.04;

    if (annualTaxableIncome <= 700000) tax = 0;

    return Math.round(tax);
  }

  computeTaxOldRegime(annualTaxableIncome: number): number {
    let tax = 0;

    if (annualTaxableIncome <= 250000) tax = 0;
    else if (annualTaxableIncome <= 500000) tax = (annualTaxableIncome - 250000) * 0.05;
    else if (annualTaxableIncome <= 1000000) tax = 12500 + (annualTaxableIncome - 500000) * 0.2;
    else tax = 112500 + (annualTaxableIncome - 1000000) * 0.3;

    if (annualTaxableIncome > 10000000) tax *= 1.15;
    else if (annualTaxableIncome > 5000000) tax *= 1.1;

    tax *= 1.04;

    if (annualTaxableIncome <= 500000) tax = 0;

    return Math.round(tax);
  }

  computeMonthlyTds(params: {
    monthlySalary: number;
    month: number;
    year: number;
    joinMonth: number | null;
    joinYear: number | null;
    fyStartMonth: number;
    declaration: TaxDeclaration | null;
    regime: 'old' | 'new';
    tdsDedutedSoFar: number;
    hasPan: boolean;
    isNonItrFiler?: boolean;
  }): number {
    const {
      monthlySalary,
      month,
      year,
      joinMonth,
      joinYear,
      fyStartMonth,
      declaration,
      regime,
      tdsDedutedSoFar,
      hasPan,
      isNonItrFiler,
    } = params;

    const { totalFyMonths, monthsRemaining } = this.getEffectiveMonthsInFy(
      month,
      year,
      joinMonth,
      joinYear,
      fyStartMonth,
    );

    const projectedAnnualSalary = monthlySalary * totalFyMonths;
    const prevEmpGross = declaration?.previousEmployerGross || 0;
    const grossAnnualIncome = projectedAnnualSalary + prevEmpGross;
    const standardDeduction = regime === 'new' ? 75000 : 50000;

    let taxableIncome = Math.max(grossAnnualIncome - standardDeduction, 0);

    if (regime === 'old' && declaration) {
      const hra = Math.min(declaration.hraExemption || 0, grossAnnualIncome * 0.5);
      const c80 = Math.min(declaration.deduction80C || 0, 150000);
      const d80 = declaration.deduction80D || 0;
      const g80 = declaration.deduction80G || 0;
      const nps = Math.min(declaration.deduction80CCD1B || 0, 50000);
      const tta = Math.min(declaration.deduction80TTA || 0, 10000);
      const other = declaration.otherDeductions || 0;

      const totalDeductions = hra + c80 + d80 + g80 + nps + tta + other;
      taxableIncome = Math.max(taxableIncome - totalDeductions, 0);
    }

    const annualTax = hasPan
      ? regime === 'new'
        ? this.computeTaxNewRegime(taxableIncome)
        : this.computeTaxOldRegime(taxableIncome)
      : Math.round(taxableIncome * 0.2);

    const prevEmpTds = declaration?.previousEmployerTds || 0;
    const tdsPaidThisFy = tdsDedutedSoFar + prevEmpTds;
    const remainingTax = Math.max(annualTax - tdsPaidThisFy, 0);
    const monthlyTds = Math.round(remainingTax / monthsRemaining);

    // Section 206AB override
    // If employee is a non-ITR filer, TDS rate is 20% flat rate
    // based on the projected annual gross income.
    if (isNonItrFiler) {
      const tdsAt20Percent = Math.round((grossAnnualIncome * 0.2) / 12);
      return Math.max(monthlyTds, tdsAt20Percent, 0);
    }

    return Math.max(monthlyTds, 0);
  }

  async getOrCreateDeclaration(
    workspaceId: string,
    teamMemberId: string,
    financialYear: number,
    regime: 'old' | 'new',
    userId: string,
  ): Promise<TaxDeclaration> {
    const wsId = new Types.ObjectId(workspaceId);
    const memberId = new Types.ObjectId(teamMemberId);

    return this.taxDeclarationModel
      .findOneAndUpdate(
        {
          workspaceId: wsId,
          teamMemberId: memberId,
          financialYear,
        },
        {
          $setOnInsert: {
            workspaceId: wsId,
            teamMemberId: memberId,
            financialYear,
            taxRegime: regime,
            standardDeduction: regime === 'new' ? 75000 : 50000,
            createdBy: new Types.ObjectId(userId),
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
        },
      )
      .exec();
  }

  async updateDeclaration(
    workspaceId: string,
    teamMemberId: string,
    financialYear: number,
    updates: Omit<UpsertTaxDeclarationDto, 'financialYear'>,
    userId: string,
  ): Promise<TaxDeclaration> {
    const wsId = new Types.ObjectId(workspaceId);
    const memberId = new Types.ObjectId(teamMemberId);
    const taxRegime = updates.taxRegime ?? 'new';
    const sanitizedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    );
    const updatePayload: Record<string, unknown> = {
      ...sanitizedUpdates,
      updatedBy: new Types.ObjectId(userId),
    };

    // OQ-S6: when an HR caller toggles the declaration lock, stamp who/when.
    // (The salary service strips `isLocked` from self-scoped worker payloads, so
    // this branch only runs for an HR/Owner caller.)
    const lockFlag = (updates as { isLocked?: boolean }).isLocked;
    if (lockFlag !== undefined) {
      updatePayload.isLocked = lockFlag;
      if (lockFlag) {
        updatePayload.lockedBy = new Types.ObjectId(userId);
        updatePayload.lockedAt = new Date();
      } else {
        updatePayload.lockedBy = null;
        updatePayload.lockedAt = null;
      }
    }

    if (updates.taxRegime) {
      updatePayload.standardDeduction = updates.taxRegime === 'new' ? 75000 : 50000;
    }

    return this.taxDeclarationModel
      .findOneAndUpdate(
        {
          workspaceId: wsId,
          teamMemberId: memberId,
          financialYear,
        },
        {
          $set: updatePayload,
          $setOnInsert: {
            workspaceId: wsId,
            teamMemberId: memberId,
            financialYear,
            createdBy: new Types.ObjectId(userId),
            taxRegime,
            standardDeduction: taxRegime === 'new' ? 75000 : 50000,
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
        },
      )
      .exec();
  }

  async getDeclaration(
    workspaceId: string,
    teamMemberId: string,
    financialYear: number,
  ): Promise<TaxDeclaration | null> {
    return this.taxDeclarationModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
        financialYear,
      })
      .exec();
  }

  async updateTdsDedutedSoFar(
    workspaceId: string,
    teamMemberId: string,
    financialYear: number,
    amount: number,
  ): Promise<void> {
    await this.taxDeclarationModel
      .findOneAndUpdate(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          teamMemberId: new Types.ObjectId(teamMemberId),
          financialYear,
        },
        { $set: { tdsDedutedSoFar: amount } },
        { upsert: false },
      )
      .exec();
  }
}
