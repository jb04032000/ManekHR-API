import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TeamMember } from '../team/schemas/team-member.schema';
import { User } from '../users/schemas/user.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import { NotificationCategory } from '../notifications/types/notification.types';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface DefaulterRow {
  /** TeamMember _id as string */
  memberId: string;
  name: string;
  designation: string;
  /** 0–100 attendance rate for the evaluated month */
  attendanceRate: number;
}

export interface DispatchChannelConfig {
  inApp: boolean;
  email: boolean;
}

export interface DispatchRecipientConfig {
  /**
   * How to resolve the recipient set:
   *  - 'specificPeople' → use specificPeople array only
   *  - 'managers'       → resolve each defaulter's reportsTo chain
   *  - 'both'           → union of both strategies (deduplicated)
   */
  mode: 'specificPeople' | 'managers' | 'both';
  /** User IDs included when mode is 'specificPeople' or 'both'. */
  specificPeople: string[];
}

export interface DispatchInput {
  workspace: {
    _id: string;
    ownerId: string;
  };
  /** 1–12 */
  month: number;
  year: number;
  thresholdPct: number;
  defaulters: DefaulterRow[];
  config: {
    channels: DispatchChannelConfig;
    recipients: DispatchRecipientConfig;
  };
}

export interface DispatchResult {
  recipientCount: number;
  channelsSent: {
    inApp: number;
    email: number;
  };
  failures: number;
}

// ── Month label helpers ──────────────────────────────────────────────────────

const MONTH_NAMES = [
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
] as const;

function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? `Month ${month}`;
}

// ── Internal dispatch channel descriptor ─────────────────────────────────────
// Keeps channel dispatch behind a thin descriptor so a future push channel
// can be added by appending here — without touching the main dispatch loop.

interface ChannelResult {
  inApp: number;
  email: number;
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class DefaulterAlertService {
  private readonly logger = new Logger(DefaulterAlertService.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly mailService: MailService,
    private readonly auditService: AuditService,
    @InjectModel(TeamMember.name) private readonly teamMemberModel: Model<TeamMember>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {}

  // ── Main dispatch entry-point ─────────────────────────────────────────────

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const { workspace, month, year, thresholdPct, defaulters, config } = input;

    // Guard: nothing to dispatch when there are no defaulters.
    if (defaulters.length === 0) {
      this.logger.log(
        `DefaulterAlertService: no defaulters for workspace ${workspace._id} ${year}-${month}; skipping dispatch`,
      );
      return { recipientCount: 0, channelsSent: { inApp: 0, email: 0 }, failures: 0 };
    }

    // ── Resolve recipients ────────────────────────────────────────────────
    const recipientSet = await this.resolveRecipientUserIds(input);

    if (recipientSet.size === 0) {
      this.logger.warn(
        `DefaulterAlertService: empty recipient set after fallback for workspace ${workspace._id} ${year}-${month}`,
      );
      return { recipientCount: 0, channelsSent: { inApp: 0, email: 0 }, failures: 0 };
    }

    // ── Build ONE digest ─────────────────────────────────────────────────
    // Compute monthLabel once here so both the in-app notification and the
    // email channel share the exact same string without recomputing it.
    const monthLabel = `${monthName(month)} ${year}`;
    const N = defaulters.length;
    const title = `${N} member${N === 1 ? '' : 's'} below the ${thresholdPct}% attendance threshold — ${monthLabel}`;
    const message = defaulters.map((d) => `${d.name} — ${d.attendanceRate.toFixed(1)}%`).join('\n');
    const link = `/dashboard/attendance/compliance?month=${month}&year=${year}`;

    // ── Fan-out per recipient ─────────────────────────────────────────────
    const channelsSent: ChannelResult = { inApp: 0, email: 0 };
    let failures = 0;

    const recipients = Array.from(recipientSet);
    await Promise.all(
      recipients.map(async (recipientUserId) => {
        try {
          if (config.channels.inApp) {
            await this.notificationsService.createNotification(workspace._id, {
              recipientId: recipientUserId,
              title,
              message,
              type: 'warning',
              metadata: {
                category: NotificationCategory.ATTENDANCE_DEFAULTER,
                month,
                year,
                link,
              },
            });
            channelsSent.inApp++;
          }

          if (config.channels.email) {
            const sent = await this.sendEmailChannel({
              workspaceId: workspace._id,
              recipientUserId,
              monthLabel,
              thresholdPct,
              defaulters,
              link,
            });
            if (sent) channelsSent.email++;
          }

          // Audit success
          this.auditService
            .logEvent({
              workspaceId: workspace._id,
              module: AppModule.ATTENDANCE,
              action: 'attendance.defaulter_alert_sent',
              entityType: 'defaulter_alert',
              entityId: new Types.ObjectId(recipientUserId),
              actorId: workspace.ownerId,
              meta: { month, year, defaulterCount: defaulters.length },
            })
            .catch((err: unknown) => {
              this.logger.warn(
                `DefaulterAlertService: audit logEvent failed for recipient ${recipientUserId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        } catch (err: unknown) {
          failures++;
          this.logger.error(
            `DefaulterAlertService: dispatch failed for recipient ${recipientUserId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.auditService
            .logEvent({
              workspaceId: workspace._id,
              module: AppModule.ATTENDANCE,
              action: 'attendance.defaulter_alert_failed',
              entityType: 'defaulter_alert',
              entityId: new Types.ObjectId(recipientUserId),
              actorId: workspace.ownerId,
              meta: {
                month,
                year,
                defaulterCount: defaulters.length,
                error: err instanceof Error ? err.message : String(err),
              },
            })
            .catch((auditErr: unknown) => {
              this.logger.warn(
                `DefaulterAlertService: failure-audit logEvent failed for recipient ${recipientUserId}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
              );
            });
        }
      }),
    );

    return {
      recipientCount: recipients.length,
      channelsSent,
      failures,
    };
  }

  // ── Recipient resolution ──────────────────────────────────────────────────

  /**
   * Resolve a deduplicated set of user IDs to notify.
   *
   * Strategy matrix:
   *   - 'specificPeople' → add each specificPeople ID.
   *   - 'managers'       → for each defaulter, follow reportsTo → manager userId.
   *                        Any defaulter with no reportsTo falls back to the owner.
   *   - 'both'           → union of both.
   *
   * If the set is still empty after all resolution → add workspace owner.
   *
   * The managers branch is batched: two queries total regardless of how many
   * defaulters are in the list (no N+1).
   */
  private async resolveRecipientUserIds(input: DispatchInput): Promise<Set<string>> {
    const { workspace, defaulters, config } = input;
    const set = new Set<string>();
    const { mode, specificPeople } = config.recipients;

    // specificPeople branch
    if (mode === 'specificPeople' || mode === 'both') {
      specificPeople.forEach((id) => set.add(id));
    }

    // managers branch — batched to avoid N+1
    if (mode === 'managers' || mode === 'both') {
      try {
        type MemberLean = {
          _id: Types.ObjectId;
          reportsTo?: Types.ObjectId | null;
          linkedUserId?: Types.ObjectId | null;
        };

        // Step 1: one query for all defaulter TeamMembers
        const memberIds = defaulters.map((d) => new Types.ObjectId(d.memberId));
        const memberDocs = await (this.teamMemberModel
          .find({ _id: { $in: memberIds } })
          .select('reportsTo linkedUserId')
          .lean()
          .exec() as Promise<MemberLean[]>);

        // Build a lookup: memberId string → doc
        const memberMap = new Map<string, MemberLean>();
        for (const doc of memberDocs) {
          memberMap.set(doc._id.toString(), doc);
        }

        // Collect distinct reportsTo ObjectIds; track which defaulters have no manager
        const reportsToIds: Types.ObjectId[] = [];
        const noManagerDefaulters: string[] = []; // memberId strings

        for (const defaulter of defaulters) {
          const doc = memberMap.get(defaulter.memberId);
          if (!doc || !doc.reportsTo) {
            noManagerDefaulters.push(defaulter.memberId);
          } else {
            reportsToIds.push(doc.reportsTo);
          }
        }

        // Defaulters with no reportsTo → fall back to workspace owner
        if (noManagerDefaulters.length > 0) {
          set.add(workspace.ownerId);
        }

        // Step 2: one query for all manager TeamMembers
        if (reportsToIds.length > 0) {
          const uniqueManagerIds = [
            ...new Map(reportsToIds.map((id) => [id.toString(), id])).values(),
          ];
          const managerDocs = await (this.teamMemberModel
            .find({ _id: { $in: uniqueManagerIds } })
            .select('linkedUserId')
            .lean()
            .exec() as Promise<MemberLean[]>);

          // Build a lookup: managerMemberId string → linkedUserId
          const managerMap = new Map<string, Types.ObjectId | null | undefined>();
          for (const doc of managerDocs) {
            managerMap.set(doc._id.toString(), doc.linkedUserId);
          }

          // For each defaulter that had a reportsTo, resolve manager linkedUserId
          for (const defaulter of defaulters) {
            const doc = memberMap.get(defaulter.memberId);
            if (!doc?.reportsTo) continue; // handled above

            const linkedUserId = managerMap.get(doc.reportsTo.toString());
            if (!linkedUserId) {
              // Manager member exists but has no linked User → fall back to owner
              set.add(workspace.ownerId);
            } else {
              set.add(linkedUserId.toString());
            }
          }
        }

        // Edge-case: if managers mode produced no entries → owner already added above,
        // but handle the edge case where all fell through and set is still empty.
        if (set.size === 0) {
          set.add(workspace.ownerId);
        }
      } catch (err: unknown) {
        this.logger.warn(
          `DefaulterAlertService: batched manager resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Resolution error → fall back to owner
        set.add(workspace.ownerId);
      }
    }

    // Final safety net
    if (set.size === 0) {
      set.add(workspace.ownerId);
    }

    return set;
  }

  // ── Email channel helper ──────────────────────────────────────────────────

  /**
   * Resolve the recipient's email address, check quota, and send the
   * defaulter-alert template via MailService.sendDefaulterAlertEmail.
   *
   * Returns true when the email was dispatched, false when skipped
   * (no email address found, or quota denied). The caller increments
   * channelsSent.email only on true.
   */
  private async sendEmailChannel(args: {
    workspaceId: string;
    recipientUserId: string;
    monthLabel: string;
    thresholdPct: number;
    defaulters: DefaulterRow[];
    link: string;
  }): Promise<boolean> {
    const { workspaceId, recipientUserId, monthLabel, thresholdPct, defaulters, link } = args;

    // Resolve User.email
    const user = (await this.userModel
      .findById(new Types.ObjectId(recipientUserId))
      .select('email name')
      .lean()
      .exec()) as { email?: string; name?: string } | null;

    if (!user?.email) {
      this.logger.warn(
        `DefaulterAlertService: no email for userId ${recipientUserId} — skipping email channel`,
      );
      return false;
    }

    // Check quota
    const quota = await this.mailService.checkEmailQuota(workspaceId);
    if (!quota.allowed) {
      this.logger.warn(
        `DefaulterAlertService: email quota denied for workspace ${workspaceId} — ${quota.reason ?? 'unknown reason'}`,
      );
      return false;
    }

    this.logger.log(
      `DefaulterAlertService: sending defaulter-alert email to ${user.email} for workspace ${workspaceId}`,
    );

    await this.mailService.sendDefaulterAlertEmail({
      to: user.email,
      monthLabel,
      thresholdPct,
      defaulters: defaulters.map((d) => ({
        name: d.name,
        designation: d.designation,
        ratePct: parseFloat(d.attendanceRate.toFixed(1)),
      })),
      complianceUrl: link,
    });

    // Increment usage counter — best-effort (mirrors salary.service pattern)
    this.mailService.incrementEmailUsage(workspaceId).catch((err: unknown) => {
      this.logger.warn(
        `DefaulterAlertService: incrementEmailUsage failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return true;
  }
}
