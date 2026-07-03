import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { GratuityLedger } from './schemas/gratuity-ledger.schema';

type GratuityAccrualEntry = {
  month: number;
  year: number;
  basicSalary: number;
  completedYears: number;
  gratuityAmount: number;
};

@Injectable()
export class GratuityService {
  constructor(
    @InjectModel(GratuityLedger.name)
    private gratuityLedgerModel: Model<GratuityLedger>,
  ) {}

  computeServiceDuration(
    dateOfJoining: Date,
    asOfMonth: number,
    asOfYear: number,
  ): { completedYears: number; completedMonths: number; totalMonths: number } {
    const joinYear = dateOfJoining.getFullYear();
    const joinMonth = dateOfJoining.getMonth() + 1;

    const totalMonths = (asOfYear - joinYear) * 12 + (asOfMonth - joinMonth);

    if (totalMonths < 0) {
      return { completedYears: 0, completedMonths: 0, totalMonths: 0 };
    }

    const completedYears = Math.floor(totalMonths / 12);
    const completedMonths = totalMonths % 12;

    return { completedYears, completedMonths, totalMonths };
  }

  computeGratuityAmount(
    lastBasicSalary: number,
    completedYears: number,
  ): number {
    if (completedYears < 5) {
      return 0;
    }

    return Math.round((lastBasicSalary * 15 * completedYears) / 26);
  }

  async updateGratuityLedger(
    workspaceId: string,
    teamMemberId: string,
    dateOfJoining: Date,
    basicSalary: number,
    month: number,
    year: number,
  ): Promise<void> {
    const wsId = new Types.ObjectId(workspaceId);
    const memberId = new Types.ObjectId(teamMemberId);
    const normalizedBasicSalary = Number(basicSalary || 0);

    const { completedYears, completedMonths } = this.computeServiceDuration(
      dateOfJoining,
      month,
      year,
    );

    const isEligible = completedYears >= 5;
    const gratuityAmount = this.computeGratuityAmount(
      normalizedBasicSalary,
      completedYears,
    );

    const newAccrual: GratuityAccrualEntry = {
      month,
      year,
      basicSalary: normalizedBasicSalary,
      completedYears,
      gratuityAmount,
    };

    const existing = await this.gratuityLedgerModel
      .findOne({ workspaceId: wsId, teamMemberId: memberId })
      .exec();

    let monthlyAccruals: GratuityAccrualEntry[] = (
      existing?.monthlyAccruals || []
    ).map((entry) => ({
      month: Number(entry.month || 0),
      year: Number(entry.year || 0),
      basicSalary: Number(entry.basicSalary || 0),
      completedYears: Number(entry.completedYears || 0),
      gratuityAmount: Number(entry.gratuityAmount || 0),
    }));

    monthlyAccruals = monthlyAccruals.filter(
      (entry) => !(entry.month === month && entry.year === year),
    );
    monthlyAccruals.push(newAccrual);

    if (monthlyAccruals.length > 24) {
      monthlyAccruals = monthlyAccruals
        .sort((a, b) =>
          a.year !== b.year ? a.year - b.year : a.month - b.month,
        )
        .slice(-24);
    }

    await this.gratuityLedgerModel.findOneAndUpdate(
      { workspaceId: wsId, teamMemberId: memberId },
      {
        $set: {
          workspaceId: wsId,
          teamMemberId: memberId,
          dateOfJoining,
          lastBasicSalary: normalizedBasicSalary,
          completedYears,
          completedMonths,
          isEligible,
          gratuityAmount,
          lastCalculatedMonth: month,
          lastCalculatedYear: year,
          monthlyAccruals,
        },
      },
      { upsert: true, new: true },
    );
  }

  async getGratuityLedger(
    workspaceId: string,
    teamMemberId: string,
  ): Promise<GratuityLedger | null> {
    return this.gratuityLedgerModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(teamMemberId),
      })
      .exec();
  }

  async getWorkspaceGratuitySummary(workspaceId: string): Promise<{
    totalEligibleEmployees: number;
    totalGratuityLiability: number;
    nearingEligibility: number;
    ledgers: Array<
      GratuityLedger & { employeeName?: string; designation?: string }
    >;
  }> {
    const wsId = new Types.ObjectId(workspaceId);

    const ledgers = await this.gratuityLedgerModel
      .find({ workspaceId: wsId })
      .populate('teamMemberId', 'name designation')
      .exec();

    const eligibleLedgers = ledgers.filter((ledger) => ledger.isEligible);
    const nearingEligibility = ledgers.filter(
      (ledger) => !ledger.isEligible && ledger.completedYears === 4,
    );

    const totalGratuityLiability = eligibleLedgers.reduce(
      (sum, ledger) => sum + ledger.gratuityAmount,
      0,
    );

    const ledgerRows = ledgers.map((ledger) => {
      const populatedMember = ledger.teamMemberId as unknown as
        | {
            _id?: Types.ObjectId | string;
            name?: string;
            designation?: string;
          }
        | undefined;

      return {
        ...(ledger.toObject() as Record<string, unknown>),
        workspaceId: String(ledger.workspaceId),
        teamMemberId: populatedMember?._id
          ? String(populatedMember._id)
          : String(ledger.teamMemberId),
        employeeName: populatedMember?.name || '',
        designation: populatedMember?.designation || '',
      } as GratuityLedger & { employeeName?: string; designation?: string };
    });

    return {
      totalEligibleEmployees: eligibleLedgers.length,
      totalGratuityLiability,
      nearingEligibility: nearingEligibility.length,
      ledgers: ledgerRows,
    };
  }

  computeFnfGratuity(
    lastBasicSalary: number,
    dateOfJoining: Date,
    lastWorkingDate: Date,
  ): {
    completedYears: number;
    completedMonths: number;
    isEligible: boolean;
    gratuityAmount: number;
  } {
    const exitMonth = lastWorkingDate.getMonth() + 1;
    const exitYear = lastWorkingDate.getFullYear();

    const { completedYears, completedMonths } = this.computeServiceDuration(
      dateOfJoining,
      exitMonth,
      exitYear,
    );

    const isEligible = completedYears >= 5;
    const gratuityAmount = this.computeGratuityAmount(
      lastBasicSalary,
      completedYears,
    );

    return { completedYears, completedMonths, isEligible, gratuityAmount };
  }
}
