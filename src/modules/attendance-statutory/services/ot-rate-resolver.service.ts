import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

export type OtRateSource = 'salary_ledger' | 'ctc_amount' | 'custom_override';

export interface OtRateResolution {
  dailyRate: number;
  source: OtRateSource;
}

@Injectable()
export class OtRateResolver {
  constructor(
    @InjectModel('Salary') private readonly salaryModel: Model<any>,
    @InjectModel('TeamMember') private readonly teamMemberModel: Model<any>,
  ) {}

  /**
   * DG-5 cascade:
   *   1. Salary.baseSalary / workingDaysInMonth (if salary record exists for (wsId, memberId, year, month))
   *   2. TeamMember.ctcAmount / 26 (standard 26-day divisor, per DG-5)
   *   3. customDailyRate (admin override)
   *   Throws BadRequestException when all three are absent/zero.
   *
   * IMPORTANT field names (verified vs schema, NOT CONTEXT.md):
   *   Salary.baseSalary  (NOT basicSalary)
   *   TeamMember.ctcAmount  (NOT ctcBreakdown.basic)
   *   Salary query uses { year, month }  (NOT yearMonth string)
   */
  async resolve(
    workspaceId: string,
    memberId: string,
    year: number,
    month: number,
    workingDaysInMonth: number,
    customDailyRate: number | undefined,
  ): Promise<OtRateResolution> {
    // Level 1: Salary ledger — query by { workspaceId, teamMemberId, year, month }
    const salaryDoc = (await this.salaryModel
      .findOne({ workspaceId, teamMemberId: memberId, year, month })
      .select('baseSalary')
      .lean()) as { baseSalary?: number } | null;
    if (salaryDoc?.baseSalary && salaryDoc.baseSalary > 0 && workingDaysInMonth > 0) {
      return {
        dailyRate: salaryDoc.baseSalary / workingDaysInMonth,
        source: 'salary_ledger',
      };
    }

    // Level 2: TeamMember ctcAmount
    const memberDoc = (await this.teamMemberModel
      .findById(memberId)
      .select('ctcAmount')
      .lean()) as { ctcAmount?: number } | null;
    if (memberDoc?.ctcAmount && memberDoc.ctcAmount > 0) {
      return {
        dailyRate: memberDoc.ctcAmount / 26,
        source: 'ctc_amount',
      };
    }

    // Level 3: custom override
    if (typeof customDailyRate === 'number' && customDailyRate > 0) {
      return { dailyRate: customDailyRate, source: 'custom_override' };
    }

    throw new BadRequestException(
      `Cannot determine daily rate for OT calculation for member ${memberId}. ` +
        'Provide a salary record for the month, set TeamMember.ctcAmount, or pass customDailyRate in the request body.',
    );
  }
}
