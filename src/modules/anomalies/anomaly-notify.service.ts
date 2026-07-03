import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Anomaly, AnomalyRuleType } from './schemas/anomaly.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';

export interface AdminRecipient {
  _id: string;
  email: string;
  name: string;
}

const EMAIL_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

const RULE_TITLES: Record<AnomalyRuleType, string> = {
  unknown_sn: 'Unknown biometric device detected',
  rapid_dup: 'Rapid duplicate punches detected',
  missed_streak: 'Missed punch streak detected',
  off_shift_punch: 'Off-shift punch detected',
  time_travel: 'Device clock anomaly detected',
  binding_conflict: 'Device binding conflict detected',
  locked_payroll_push: 'Punch into a locked payroll period',
};

@Injectable()
export class AnomalyNotifyService {
  private readonly logger = new Logger(AnomalyNotifyService.name);

  constructor(
    @InjectModel(Anomaly.name) private readonly anomalyModel: Model<Anomaly>,
    private readonly notificationsService: NotificationsService,
    private readonly mailService: MailService,
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    @InjectModel('WorkspaceMember') private readonly workspaceMemberModel: Model<any>,
    @InjectModel('User') private readonly userModel: Model<any>,
  ) {}

  /**
   * Returns workspace owner + active members with attendance.manage_anomalies permission.
   * This correctly matches the anomaly-surface permission (ModuleAction.MANAGE_ANOMALIES)
   * rather than the device-surface permission (manage_devices).
   * STRIDE-I mitigation: query uses wsId ObjectId filter — members of other workspaces
   * cannot appear in this result.
   */
  async resolveAdminRecipients(wsId: string): Promise<AdminRecipient[]> {
    const wsObjectId = new Types.ObjectId(wsId);

    const ws = await this.workspaceModel.findById(wsObjectId).select('name ownerId').lean().exec();
    if (!ws) return [];

    const members = await this.workspaceMemberModel
      .find({ workspaceId: wsObjectId, status: 'active' }, {})
      .populate('roleId', 'permissions')
      .populate('userId', 'email name')
      .lean()
      .exec();

    const recipientUserIds = new Set<string>();
    recipientUserIds.add(String(ws.ownerId));

    for (const m of members) {
      if (!m.userId) continue;
      const perms: Array<{ module: string; actions: string[] }> = m.roleId?.permissions ?? [];
      if (perms.some((p) => p.module === 'attendance' && p.actions?.includes('manage_anomalies'))) {
        recipientUserIds.add(String(m.userId._id ?? m.userId));
      }
    }

    const users = await this.userModel
      .find({ _id: { $in: Array.from(recipientUserIds) } })
      .select('email name')
      .lean()
      .exec();

    return users.map((u: any) => ({
      _id: String(u._id),
      email: u.email,
      name: u.name,
    }));
  }

  /**
   * Fan-out for a recorded Anomaly.
   * - In-app: always fires per recipient
   * - Email: de-duped by {wsId, ruleType, contextKey} within 24h
   * Errors swallowed at per-recipient granularity — never throws.
   */
  async dispatch(anomaly: Anomaly): Promise<void> {
    try {
      const wsId = String(anomaly.wsId);
      const recipients = await this.resolveAdminRecipients(wsId);
      if (recipients.length === 0) return;

      const ruleTitle = RULE_TITLES[anomaly.ruleType] ?? 'Attendance anomaly';

      // In-app — always fires regardless of email de-dupe outcome
      for (const r of recipients) {
        this.notificationsService
          .createNotification(wsId, {
            recipientId: r._id,
            title: ruleTitle,
            message: this.buildMessage(anomaly),
            type:
              anomaly.severity === 'high'
                ? 'error'
                : anomaly.severity === 'medium'
                  ? 'warning'
                  : 'info',
            metadata: {
              entityId: String((anomaly as any)._id),
              entityType: 'anomaly',
              ruleType: anomaly.ruleType,
            },
          })
          .catch((err: any) => {
            this.logger.warn(`[AnomalyNotify] in-app failed for ${r._id}: ${err?.message}`);
          });
      }

      // Email de-dupe: skip if an email was already dispatched for the same
      // anomaly group within the last 24h. When contextKey is present, dedup on
      // it directly. When absent (contextKey is null), dedup on the natural
      // grouping {wsId, ruleType, teamMemberId} — stored anomaly docs carry
      // contextKey:null verbatim, so a synthetic fallback key would never match
      // them and a missing contextKey would otherwise cause unbounded email spam.
      const teamMemberId = (anomaly as any).teamMemberId ?? null;
      const since = new Date(Date.now() - EMAIL_DEDUPE_WINDOW_MS);
      const dedupeFilter: Record<string, unknown> = {
        wsId: anomaly.wsId,
        ruleType: anomaly.ruleType,
        emailDispatchedAt: { $gte: since },
      };
      if (anomaly.contextKey) {
        dedupeFilter.contextKey = anomaly.contextKey;
      } else {
        // No contextKey → group on the natural identity fields. Include
        // deviceSerial when present so distinct unknown devices (unknown_sn,
        // which carries no member/contextKey) do not cross-suppress each other.
        dedupeFilter.contextKey = null;
        dedupeFilter.teamMemberId = teamMemberId;
        const deviceSerial = (anomaly as any).deviceSerial ?? null;
        if (deviceSerial) dedupeFilter.deviceSerial = deviceSerial;
      }
      const recentEmail = await this.anomalyModel.findOne(dedupeFilter);
      if (recentEmail) {
        this.logger.log(
          `[AnomalyNotify] Skipping email (24h dedupe) for ${anomaly.ruleType}/${String(
            anomaly.contextKey ?? teamMemberId,
          )}`,
        );
        return;
      }

      // Email dispatch per recipient
      const feedUrl = 'https://app.manekhr.in/dashboard/attendance/anomalies';
      for (const r of recipients) {
        this.mailService
          .sendAnomalyAlertEmail(
            { email: r.email, name: r.name },
            {
              ruleType: anomaly.ruleType,
              severity: anomaly.severity,
              title: ruleTitle,
              detail: this.buildMessage(anomaly),
              feedUrl,
            },
          )
          .catch((err: any) => {
            this.logger.warn(`[AnomalyNotify] email failed for ${r.email}: ${err?.message}`);
          });
      }

      // Stamp email dispatch timestamp on anomaly for future de-dupe
      await this.anomalyModel.updateOne(
        { _id: (anomaly as any)._id },
        { $set: { emailDispatchedAt: new Date() } },
      );
    } catch (err: any) {
      this.logger.warn(`[AnomalyNotify] dispatch failed: ${err?.message}`);
    }
  }

  private buildMessage(anomaly: Anomaly): string {
    const ctx: any = anomaly.context ?? {};
    switch (anomaly.ruleType) {
      case 'unknown_sn':
        return `Device SN ${ctx.serial ?? anomaly.deviceSerial ?? 'unknown'} is pushing events without approval.`;
      case 'rapid_dup':
        return `${ctx.eventCount ?? '>=5'} events in ${ctx.windowSeconds ?? 10}s from device ${ctx.deviceSerial ?? anomaly.deviceSerial ?? '?'}.`;
      case 'missed_streak':
        return `No punches for ${ctx.streakLength ?? 3} consecutive working days.`;
      case 'off_shift_punch':
        return `Punch at ${ctx.eventTimestamp ?? '?'} is ${ctx.deltaMinutes ?? '?'} minutes outside shift bounds.`;
      case 'time_travel':
        return `Event timestamp differs from server time by ${ctx.deltaMinutes ?? '?'} minutes.`;
      default:
        return 'Attendance anomaly detected.';
    }
  }
}
