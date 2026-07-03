import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { WorkspaceMember } from '../workspaces/schemas/workspace-member.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { Attendance } from '../attendance/schemas/attendance.schema';
import { Salary } from '../salary/schemas/salary.schema';

/**
 * Wave B Permission-Gated UI (2026-05-15) — self-scoped dashboard bundle.
 *
 * Restricted invitees (non-owner members without `team.view`) land on a
 * dashboard that aggregates workspace-wide data they cannot read. This
 * service returns the *self-only* slice instead: caller's own attendance
 * for the current month, caller's own salary row for the current month,
 * caller's basic profile + role label for the greeting.
 *
 * Resolution chain: WorkspaceMember(userId, workspaceId, status=active)
 * → linkedTeamMemberId → TeamMember. If the caller has no linked
 * TeamMember (e.g. an owner who never seeded themselves a TeamMember
 * row) we return null sections; the FE falls back to the empty-state
 * card. Self-scope by definition — no RBAC check beyond "is a member of
 * this workspace" (enforced at the controller via JwtAuthGuard +
 * MeDashboardController's manual membership check).
 */
@Injectable()
export class MeDashboardService {
  private readonly logger = new Logger(MeDashboardService.name);

  constructor(
    @InjectModel(WorkspaceMember.name)
    private workspaceMemberModel: Model<WorkspaceMember>,
    @InjectModel(TeamMember.name) private teamMemberModel: Model<TeamMember>,
    @InjectModel(Attendance.name) private attendanceModel: Model<Attendance>,
    @InjectModel(Salary.name) private salaryModel: Model<Salary>,
  ) {}

  async getDashboard(userId: string, workspaceId: string) {
    if (!Types.ObjectId.isValid(workspaceId)) {
      throw new NotFoundException('Workspace not found');
    }
    const userOid = new Types.ObjectId(userId);
    const wsOid = new Types.ObjectId(workspaceId);

    const membership = await this.workspaceMemberModel
      .findOne({ workspaceId: wsOid, userId: userOid, status: 'active' })
      .lean()
      .exec();

    if (!membership) {
      // Owner viewing their own workspace doesn't have a WorkspaceMember
      // row (they're the owner, not a member). Return a stub bundle so
      // the endpoint never 404s — the FE only ever routes restricted
      // members here, so this branch is defensive.
      return this.emptyBundle();
    }

    const teamMember = membership.linkedTeamMemberId
      ? await this.teamMemberModel
          .findById(new Types.ObjectId(String(membership.linkedTeamMemberId)))
          .lean()
          .exec()
      : null;

    if (!teamMember) {
      return this.emptyBundle();
    }

    const tmOid = teamMember._id;

    // Current month boundaries in server TZ. We deliberately use server
    // local (Asia/Kolkata in prod via env) rather than UTC since salary
    // + attendance rows are stamped in IST.
    const now = new Date();
    const year = now.getFullYear();
    const month1to12 = now.getMonth() + 1;
    const monthStart = new Date(year, now.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, now.getMonth() + 1, 1, 0, 0, 0, 0);

    const [attendanceRows, salaryRow] = await Promise.all([
      this.attendanceModel
        .find({
          workspaceId: wsOid,
          teamMemberId: tmOid,
          date: { $gte: monthStart, $lt: monthEnd },
        })
        .select({ status: 1, date: 1 })
        .lean()
        .exec(),
      this.salaryModel
        .findOne({
          workspaceId: wsOid,
          teamMemberId: tmOid,
          year,
          month: month1to12,
        })
        .lean()
        .exec(),
    ]);

    // Reduce attendance rows to status counts. Statuses tracked in the
    // existing Attendance schema: present / absent / half_day / on_leave
    // / late. Unknown values bucket into `other` so the response stays
    // strict-shape regardless of future enum extensions.
    const counts = {
      present: 0,
      absent: 0,
      half_day: 0,
      on_leave: 0,
      late: 0,
      other: 0,
    };
    for (const row of attendanceRows) {
      const status = String((row as { status?: string }).status ?? '');
      if (status in counts) {
        (counts as Record<string, number>)[status] += 1;
      } else if (status) {
        counts.other += 1;
      }
    }
    const totalDays = attendanceRows.length;

    return {
      member: {
        id: String(tmOid),
        name: (teamMember as { name?: string }).name ?? '',
        designation: (teamMember as { designation?: string }).designation ?? null,
      },
      attendanceMonthly: {
        year,
        month: month1to12,
        totalDays,
        present: counts.present,
        absent: counts.absent,
        halfDay: counts.half_day,
        onLeave: counts.on_leave,
        late: counts.late,
        other: counts.other,
      },
      salaryCurrentMonth: salaryRow
        ? {
            id: String((salaryRow as { _id?: unknown })._id ?? ''),
            year,
            month: month1to12,
            baseSalary: (salaryRow as { baseSalary?: number }).baseSalary ?? 0,
            presentDays: (salaryRow as { presentDays?: number }).presentDays ?? 0,
            totalDays: (salaryRow as { totalDays?: number }).totalDays ?? 0,
            deductions: (salaryRow as { deductions?: number }).deductions ?? 0,
            additions: (salaryRow as { additions?: number }).additions ?? 0,
            netSalary: (salaryRow as { netSalary?: number }).netSalary ?? 0,
            paidAmount: (salaryRow as { paidAmount?: number }).paidAmount ?? 0,
            paymentStatus: (salaryRow as { paymentStatus?: string }).paymentStatus ?? 'pending',
          }
        : null,
    };
  }

  private emptyBundle() {
    const now = new Date();
    return {
      member: null,
      attendanceMonthly: {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        totalDays: 0,
        present: 0,
        absent: 0,
        halfDay: 0,
        onLeave: 0,
        late: 0,
        other: 0,
      },
      salaryCurrentMonth: null,
    };
  }
}
