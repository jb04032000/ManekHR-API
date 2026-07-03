import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Salary } from '../salary/schemas/salary.schema';
import { Payment } from '../salary/schemas/payment.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * HR OVERVIEW aggregation — the people-metrics powering the ManekHR admin
 * landing screen (NOT the manufacturing dashboard, which is machine-gated and
 * excluded for ManekHR). Reads ONLY the team + salary collections; it never
 * touches machine/production/finance data.
 *
 * Cross-module links:
 *   - team module        -> TeamMember schema (active headcount, joiners, breakdowns)
 *   - salary module      -> Salary + Payment schemas (this-month net payable / paid)
 *   - subscriptions      -> SubscriptionsService.hasModule (per-workspace SALARY gate)
 *
 * Watch:
 *   - Salary numbers are GATED on the SALARY module being enabled for the
 *     workspace. When SALARY is off, `salary` comes back null so the UI shows a
 *     "salary disabled" state instead of misleading zeros. The controller
 *     already enforces SALARY VIEW scope=all (caller RBAC), so a worker can
 *     never reach this with another member's figures.
 *   - Month math mirrors statistics.service.getDashboardStats: salary records
 *     are keyed on the integer (month, year) pair, NOT UTC date windows.
 */

export interface HrOverviewByDesignation {
  designation: string;
  count: number;
}

export interface HrOverviewSalary {
  monthLabel: string;
  month: number;
  year: number;
  totalPayable: number;
  totalPaid: number;
  totalPending: number;
  employeesCount: number;
  paidEmployeesCount: number;
  pendingEmployeesCount: number;
  payrollGenerated: boolean;
}

export interface HrOverviewResponse {
  generatedAt: string;
  headcount: {
    active: number;
    addedThisMonth: number;
    withAppAccess: number;
  };
  byDesignation: HrOverviewByDesignation[];
  salary: HrOverviewSalary | null;
  modules: {
    salaryEnabled: boolean;
  };
}

@Injectable()
export class HrOverviewService {
  constructor(
    @InjectModel(TeamMember.name) private readonly teamModel: Model<TeamMember>,
    @InjectModel(Salary.name) private readonly salaryModel: Model<Salary>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    // Global provider (SubscriptionsModule is @Global). Optional so the unit
    // spec can construct this service without the full DI graph.
    @Optional() private readonly subscriptionsService?: SubscriptionsService,
  ) {}

  /**
   * Build the HR overview bundle for one workspace. Caller RBAC (TEAM view +
   * SALARY view scope=all) is enforced at the controller; this method assumes a
   * trusted, workspace-scoped call.
   */
  async getOverview(workspaceId: string): Promise<HrOverviewResponse> {
    const now = new Date();
    const currentMonth = now.getMonth() + 1; // 1-12
    const currentYear = now.getFullYear();

    // Workspace id is stored as ObjectId on every collection, but some legacy
    // rows persisted it as a string — match both, same as the statistics svc.
    const workspaceFilter = {
      $in: [workspaceId, new Types.ObjectId(workspaceId)],
    };

    // Start-of-month boundary (server TZ) for the "added this month" join count.
    const monthStart = new Date(currentYear, now.getMonth(), 1, 0, 0, 0, 0);

    // ── 1. Headcount + designation breakdown (single aggregation) ──────────
    // Active = not soft-deleted, not permanently deleted, isActive:true. This is
    // the same universe the payroll generator and statistics dashboard use.
    const baseActiveMatch = {
      workspaceId: workspaceFilter,
      isActive: true,
      isDeleted: { $ne: true },
      isPermanentlyDeleted: { $ne: true },
    };

    const [headcountAgg] = await this.teamModel
      .aggregate<{
        active: number;
        addedThisMonth: number;
        withAppAccess: number;
        byDesignation: Array<{ designation: string | null; count: number }>;
      }>([
        { $match: baseActiveMatch },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  active: { $sum: 1 },
                  withAppAccess: {
                    $sum: { $cond: [{ $eq: ['$hasAppAccess', true] }, 1, 0] },
                  },
                  // dateOfJoining within the current calendar month.
                  addedThisMonth: {
                    $sum: {
                      $cond: [{ $gte: ['$dateOfJoining', monthStart] }, 1, 0],
                    },
                  },
                },
              },
            ],
            designation: [
              {
                $group: {
                  _id: { $ifNull: ['$designation', null] },
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1, _id: 1 } },
            ],
          },
        },
        {
          $project: {
            active: { $ifNull: [{ $arrayElemAt: ['$totals.active', 0] }, 0] },
            withAppAccess: {
              $ifNull: [{ $arrayElemAt: ['$totals.withAppAccess', 0] }, 0],
            },
            addedThisMonth: {
              $ifNull: [{ $arrayElemAt: ['$totals.addedThisMonth', 0] }, 0],
            },
            byDesignation: {
              $map: {
                input: '$designation',
                as: 'd',
                in: { designation: '$$d._id', count: '$$d.count' },
              },
            },
          },
        },
      ])
      .exec();

    const headcount = {
      active: headcountAgg?.active ?? 0,
      addedThisMonth: headcountAgg?.addedThisMonth ?? 0,
      withAppAccess: headcountAgg?.withAppAccess ?? 0,
    };

    const byDesignation: HrOverviewByDesignation[] = (headcountAgg?.byDesignation ?? [])
      .map((d) => ({
        designation: d.designation && String(d.designation).trim() ? String(d.designation) : 'Unassigned',
        count: d.count,
      }))
      // Cap to the top designations so the card stays readable; the rest roll
      // up under "Unassigned"/tail naturally because the aggregation sorts desc.
      .slice(0, 8);

    // ── 2. Salary (this month) — GATED on the SALARY module entitlement ────
    const salaryEnabled = this.subscriptionsService
      ? await this.subscriptionsService.hasModule(workspaceId, AppModule.SALARY)
      : true;

    let salary: HrOverviewSalary | null = null;
    if (salaryEnabled) {
      salary = await this.buildSalarySummary(
        workspaceFilter,
        currentMonth,
        currentYear,
        now,
      );
    }

    return {
      generatedAt: now.toISOString(),
      headcount,
      byDesignation,
      salary,
      modules: { salaryEnabled },
    };
  }

  /**
   * This-month payroll summary derived from Salary + Payment rows, mirroring the
   * statistics dashboard's salary math: net payable per member, payments summed
   * per member (only active payments), pending = payable - paid. A member counts
   * as "paid" once their payments cover their net salary.
   *
   * Keep in sync with statistics.service.getDashboardStats salary block.
   */
  private async buildSalarySummary(
    workspaceFilter: { $in: Array<string | Types.ObjectId> },
    month: number,
    year: number,
    now: Date,
  ): Promise<HrOverviewSalary> {
    const monthLabel = now.toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });

    const salaryRecords = await this.salaryModel
      .find({ workspaceId: workspaceFilter, month, year })
      .select('_id teamMemberId netSalary')
      .lean<Array<{ _id: Types.ObjectId; teamMemberId: Types.ObjectId; netSalary: number }>>();

    const payrollGenerated = salaryRecords.length > 0;

    if (!payrollGenerated) {
      return {
        monthLabel,
        month,
        year,
        totalPayable: 0,
        totalPaid: 0,
        totalPending: 0,
        employeesCount: 0,
        paidEmployeesCount: 0,
        pendingEmployeesCount: 0,
        payrollGenerated: false,
      };
    }

    const salaryIds = salaryRecords.map((s) => s._id);
    const salaryIdsStr = salaryIds.map((id) => String(id));
    const payments = await this.paymentModel
      .find({
        workspaceId: workspaceFilter,
        salaryId: { $in: [...salaryIds, ...salaryIdsStr] },
        // Only count active (non-reversed) payments toward "paid".
        status: { $ne: 'reversed' },
      })
      .select('teamMemberId amount')
      .lean<Array<{ teamMemberId: Types.ObjectId; amount: number }>>();

    const paidByMember = new Map<string, number>();
    for (const p of payments) {
      const key = String(p.teamMemberId);
      paidByMember.set(key, (paidByMember.get(key) ?? 0) + (p.amount || 0));
    }

    let totalPayable = 0;
    let totalPaid = 0;
    let paidEmployeesCount = 0;

    for (const record of salaryRecords) {
      const net = record.netSalary > 0 ? record.netSalary : 0;
      const memberPaid = paidByMember.get(String(record.teamMemberId)) ?? 0;
      totalPayable += net;
      totalPaid += memberPaid;
      if (net > 0 && memberPaid >= net) paidEmployeesCount++;
    }

    const round = (n: number) => Math.round(n);
    const roundedPayable = round(totalPayable);
    const roundedPaid = round(totalPaid);

    return {
      monthLabel,
      month,
      year,
      totalPayable: roundedPayable,
      totalPaid: roundedPaid,
      totalPending: Math.max(0, roundedPayable - roundedPaid),
      employeesCount: salaryRecords.length,
      paidEmployeesCount,
      pendingEmployeesCount: Math.max(0, salaryRecords.length - paidEmployeesCount),
      payrollGenerated: true,
    };
  }
}
