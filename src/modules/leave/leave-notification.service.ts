import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { User } from '../users/schemas/user.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { LeaveRequest, LeaveApprovalStep } from './schemas/leave-request.schema';
import { CompOffRequest } from './schemas/comp-off-request.schema';

/** Normalised view of a leave / comp-off request the notification fan-out works from. */
interface RequestNotice {
  kind: 'leave' | 'comp_off';
  /** Title-case label for headlines — `Leave` / `Comp-off`. */
  kindLabel: string;
  entityId: string;
  workspaceId: string;
  teamMemberId: Types.ObjectId;
  appliedBy: Types.ObjectId;
  status: string;
  currentLevel: number;
  approvalChain: LeaveApprovalStep[];
  reason: string | null;
  detailLines: Array<{ label: string; value: string }>;
  /** FE deep-link path appended to the web-app base URL. */
  ctaPath: string;
}

interface NoticeContext {
  wsName: string;
  memberName: string;
  /** The member's linked login user, when they have one. */
  memberUserId: string | null;
}

interface FanOutPayload {
  headline: string;
  intro: string;
  type: 'info' | 'warning';
  note?: string | null;
}

/**
 * Leave epic L3c4 — fan-out of in-app + email notifications across the leave
 * and comp-off request lifecycles. Every method is fire-and-forget safe: each
 * recipient send is independently guarded, and the public methods never throw.
 */
@Injectable()
export class LeaveNotificationService {
  private readonly logger = new Logger(LeaveNotificationService.name);
  private static readonly MONTHS = [
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

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(TeamMember.name)
    private readonly memberModel: Model<TeamMember>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly notificationsService: NotificationsService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  // ──────────────────────────── leave ────────────────────────────

  async leaveApplied(workspaceId: string, req: LeaveRequest): Promise<void> {
    await this.guard('leaveApplied', () => this.onApplied(this.leaveNotice(workspaceId, req)));
  }

  async leaveDecided(workspaceId: string, req: LeaveRequest): Promise<void> {
    await this.guard('leaveDecided', () => this.onDecided(this.leaveNotice(workspaceId, req)));
  }

  async leaveClosed(workspaceId: string, req: LeaveRequest): Promise<void> {
    await this.guard('leaveClosed', () => this.onClosed(this.leaveNotice(workspaceId, req)));
  }

  // ─────────────────────────── comp-off ───────────────────────────

  async compOffApplied(workspaceId: string, req: CompOffRequest): Promise<void> {
    await this.guard('compOffApplied', () => this.onApplied(this.compOffNotice(workspaceId, req)));
  }

  async compOffDecided(workspaceId: string, req: CompOffRequest): Promise<void> {
    await this.guard('compOffDecided', () => this.onDecided(this.compOffNotice(workspaceId, req)));
  }

  async compOffClosed(workspaceId: string, req: CompOffRequest): Promise<void> {
    await this.guard('compOffClosed', () => this.onClosed(this.compOffNotice(workspaceId, req)));
  }

  // ──────────────────────── notice builders ───────────────────────

  private leaveNotice(workspaceId: string, req: LeaveRequest): RequestNotice {
    return {
      kind: 'leave',
      kindLabel: 'Leave',
      entityId: String(req._id),
      workspaceId,
      teamMemberId: req.teamMemberId,
      appliedBy: req.appliedBy,
      status: req.status,
      currentLevel: req.currentLevel,
      approvalChain: req.approvalChain,
      reason: req.reason,
      detailLines: [
        { label: 'Dates', value: this.formatRange(req.fromDate, req.toDate) },
        { label: 'Total days', value: String(req.totalDays) },
      ],
      ctaPath: `/dashboard/leave/requests/${String(req._id)}`,
    };
  }

  private compOffNotice(workspaceId: string, req: CompOffRequest): RequestNotice {
    return {
      kind: 'comp_off',
      kindLabel: 'Comp-off',
      entityId: String(req._id),
      workspaceId,
      teamMemberId: req.teamMemberId,
      appliedBy: req.appliedBy,
      status: req.status,
      currentLevel: req.currentLevel,
      approvalChain: req.approvalChain,
      reason: req.reason,
      detailLines: [
        { label: 'Worked on', value: this.formatDate(req.workDate) },
        { label: 'Days earned', value: String(req.quantity) },
      ],
      ctaPath: `/dashboard/leave/comp-off-requests/${String(req._id)}`,
    };
  }

  // ──────────────────────── lifecycle moments ─────────────────────

  private async onApplied(notice: RequestNotice): Promise<void> {
    const ctx = await this.resolveContext(notice);
    const kind = notice.kindLabel;
    if (notice.status === 'pending') {
      const approver = this.approverAt(notice, notice.currentLevel);
      await this.fanOut(notice, ctx, approver ? [approver] : [], {
        headline: `${kind} request awaiting approval`,
        intro: `A ${kind.toLowerCase()} request for ${ctx.memberName} needs your approval.`,
        type: 'info',
      });
    } else if (notice.status === 'approved') {
      await this.fanOut(notice, ctx, this.applicantAndMember(notice, ctx), {
        headline: `${kind} request approved`,
        intro: `The ${kind.toLowerCase()} request for ${ctx.memberName} has been approved.`,
        type: 'info',
      });
    }
  }

  private async onDecided(notice: RequestNotice): Promise<void> {
    const ctx = await this.resolveContext(notice);
    const kind = notice.kindLabel;
    if (notice.status === 'pending') {
      const approver = this.approverAt(notice, notice.currentLevel);
      await this.fanOut(notice, ctx, approver ? [approver] : [], {
        headline: `${kind} request needs your approval`,
        intro: `A ${kind.toLowerCase()} request for ${ctx.memberName} has reached your approval level.`,
        type: 'info',
      });
    } else if (notice.status === 'approved') {
      await this.fanOut(notice, ctx, this.applicantAndMember(notice, ctx), {
        headline: `${kind} request approved`,
        intro: `The ${kind.toLowerCase()} request for ${ctx.memberName} has been approved.`,
        type: 'info',
        note: this.latestNote(notice),
      });
    } else if (notice.status === 'rejected') {
      await this.fanOut(notice, ctx, this.applicantAndMember(notice, ctx), {
        headline: `${kind} request rejected`,
        intro: `The ${kind.toLowerCase()} request for ${ctx.memberName} was rejected.`,
        type: 'warning',
        note: this.latestNote(notice),
      });
    }
  }

  private async onClosed(notice: RequestNotice): Promise<void> {
    const ctx = await this.resolveContext(notice);
    const kind = notice.kindLabel;
    if (notice.status === 'cancelled') {
      const approver = this.approverAt(notice, 1);
      await this.fanOut(notice, ctx, approver ? [approver] : [], {
        headline: `${kind} request cancelled`,
        intro: `${ctx.memberName}'s ${kind.toLowerCase()} request was cancelled by the applicant.`,
        type: 'warning',
      });
    } else if (notice.status === 'withdrawn') {
      await this.fanOut(notice, ctx, this.decidedApprovers(notice), {
        headline: `${kind} request withdrawn`,
        intro: `An approved ${kind.toLowerCase()} request for ${ctx.memberName} was withdrawn by the applicant.`,
        type: 'warning',
      });
    }
  }

  // ──────────────────────────── fan-out ───────────────────────────

  private async fanOut(
    notice: RequestNotice,
    ctx: NoticeContext,
    recipientUserIds: string[],
    payload: FanOutPayload,
  ): Promise<void> {
    const unique = [...new Set(recipientUserIds.filter((id) => id.length > 0))];
    if (unique.length === 0) return;

    const baseUrl = this.configService.get<string>('app.webAppUrl') ?? 'https://app.manekhr.in';
    const ctaUrl = `${baseUrl}${notice.ctaPath}`;
    const lines = [{ label: 'Member', value: ctx.memberName }, ...notice.detailLines];
    const entityType = notice.kind === 'leave' ? 'leave_request' : 'comp_off_request';

    for (const recipientId of unique) {
      try {
        // dispatch (not createNotification) so the channel pipeline runs:
        // in-platform bell/socket + mobile/browser push where the recipient
        // has a registered device. createNotification only persisted the row,
        // which is why leave events never produced a browser notification.
        await this.notificationsService.dispatch({
          recipientId,
          category: 'erp.leave_update',
          title: payload.headline,
          message: payload.intro,
          type: payload.type,
          workspaceId: notice.workspaceId,
          entityType,
          entityId: notice.entityId,
          // entityType/entityId duplicated in metadata for legacy FE readers
          // that key off metadata (mirrors the old createNotification shape).
          metadata: { entityType, entityId: notice.entityId, link: ctaUrl },
        });
      } catch (err) {
        this.logger.warn(`in-app notify failed for ${recipientId}: ${this.msg(err)}`);
      }

      try {
        const user = await this.userModel.findById(recipientId).select('email name').lean().exec();
        if (user?.email) {
          await this.mailService.sendLeaveNotification(
            { email: user.email, name: user.name ?? 'there' },
            {
              subject: `${payload.headline} — ${ctx.memberName}`,
              headline: payload.headline,
              intro: payload.intro,
              lines,
              reason: notice.reason,
              note: payload.note ?? null,
              ctaUrl,
              ctaLabel: 'View request',
              wsName: ctx.wsName,
            },
          );
        }
      } catch (err) {
        this.logger.warn(`email notify failed for ${recipientId}: ${this.msg(err)}`);
      }
    }
  }

  // ──────────────────────────── helpers ───────────────────────────

  private async resolveContext(notice: RequestNotice): Promise<NoticeContext> {
    const ws = await this.workspaceModel.findById(notice.workspaceId).select('name').lean().exec();
    const member = await this.memberModel
      .findById(notice.teamMemberId)
      .select('name linkedUserId')
      .lean()
      .exec();
    return {
      wsName: ws?.name ?? 'Workspace',
      memberName: member?.name ?? 'a member',
      // Not populated (no `.populate`) — `linkedUserId` is an ObjectId at runtime.
      memberUserId: member?.linkedUserId
        ? (member.linkedUserId as Types.ObjectId).toString()
        : null,
    };
  }

  private approverAt(notice: RequestNotice, level: number): string | null {
    const step = notice.approvalChain[level - 1];
    return step ? step.approverUserId.toString() : null;
  }

  private decidedApprovers(notice: RequestNotice): string[] {
    return notice.approvalChain
      .filter((s) => s.decision !== null)
      .map((s) => s.approverUserId.toString());
  }

  private applicantAndMember(notice: RequestNotice, ctx: NoticeContext): string[] {
    const ids = [notice.appliedBy.toString()];
    if (ctx.memberUserId) ids.push(ctx.memberUserId);
    return ids;
  }

  private latestNote(notice: RequestNotice): string | null {
    for (let i = notice.approvalChain.length - 1; i >= 0; i--) {
      const note = notice.approvalChain[i].note;
      if (note) return note;
    }
    return null;
  }

  private formatDate(d: Date): string {
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${day} ${LeaveNotificationService.MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  private formatRange(from: Date, to: Date): string {
    if (from.getTime() === to.getTime()) return this.formatDate(from);
    return `${this.formatDate(from)} – ${this.formatDate(to)}`;
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : 'unknown error';
  }

  private async guard(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`${label} notification failed: ${this.msg(err)}`);
    }
  }
}
