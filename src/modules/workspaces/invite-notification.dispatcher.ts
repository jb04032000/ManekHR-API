import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { UserDevicesService } from '../user-devices/user-devices.service';

export interface InviteNotificationContext {
  workspaceId: string;
  workspaceName: string;
  inviterName: string;
  inviteeIdentifier: string;
  inviteeType: 'email' | 'mobile';
  inviteeUserId?: string;
  inviteeEmail?: string;
  role: string;
  inviteUrl: string;
  mobileDeepLink: string;
  /**
   * P1.5 (2026-05-14) — controls which delivery channels fire.
   *   - 'auto' / undefined → in-app + email + SMS (existing behaviour)
   *   - 'both'             → same as 'auto'
   *   - 'link'             → in-app only; email + SMS suppressed so the
   *                          owner can share the URL manually
   */
  sendMethod?: 'auto' | 'link' | 'both';
  /**
   * P2.0.2 (2026-05-15) — per-channel override. When set, this list is the
   * authoritative dispatch target — sendMethod is ignored. Empty array =
   * suppress every channel (caller wants the token only, e.g. "Just rotate
   * the link" or grant with no dispatch).
   */
  channels?: ('email' | 'sms' | 'in_app')[];
}

@Injectable()
export class InviteNotificationDispatcher {
  private readonly logger = new Logger(InviteNotificationDispatcher.name);
  private readonly webAppUrl: string;

  constructor(
    private notificationsService: NotificationsService,
    private mailService: MailService,
    private smsService: SmsService,
    private configService: ConfigService,
    private userDevicesService: UserDevicesService,
  ) {
    this.webAppUrl = this.configService.get<string>('app.webAppUrl') || 'https://app.manekhr.in';
  }

  async dispatch(context: InviteNotificationContext): Promise<void> {
    this.logger.log(`Dispatching invite notification for ${context.inviteeIdentifier}`);

    // P2.0.2 (2026-05-15) — channels[] is authoritative when present.
    // sendMethod is the legacy fallback for callers (mobile app, older
    // server-action wrappers) that haven't migrated to per-channel control.
    const hasChannels = Array.isArray(context.channels);
    const wantInApp = hasChannels ? context.channels.includes('in_app') : true; // legacy: in-app always fires for known users
    const wantEmail = hasChannels
      ? context.channels.includes('email')
      : context.sendMethod !== 'link';
    const wantSms = hasChannels ? context.channels.includes('sms') : context.sendMethod !== 'link';

    // Existing user: create in-app notification
    if (wantInApp && context.inviteeUserId) {
      this.logger.log(`Creating in-app notification for existing user ${context.inviteeUserId}`);
      // P1.8-revert.10 (2026-05-14) — `type` is the severity column on the
      // current Notification schema (info|warning|success|error). Category
      // ('INVITE_RECEIVED') lives under metadata.category until the P2
      // schema overhaul introduces a first-class `category` field.
      // Previously this passed `type: 'INVITE_RECEIVED'`, which failed
      // mongoose enum validation and threw inside the grant transaction.
      try {
        await this.notificationsService.createNotification(context.workspaceId, {
          recipientId: context.inviteeUserId,
          type: 'info',
          title: 'Workspace Invitation',
          message: `${context.inviterName} invited you to join ${context.workspaceName} as ${context.role}`,
          metadata: {
            category: 'INVITE_RECEIVED',
            workspaceId: context.workspaceId,
            workspaceName: context.workspaceName,
            role: context.role,
            inviteUrl: context.inviteUrl,
          },
        });
      } catch (e) {
        // Notification fan-out is best-effort — must not block the grant.
        this.logger.error(
          `Failed to create in-app notification for user ${context.inviteeUserId}: ${(e as Error)?.message ?? e}`,
        );
      }

      // Mobile push fan-out — best-effort, fire-and-forget. Failures are
      // logged inside UserDevicesService and must never block the invite flow.
      this.userDevicesService
        .pushUser(context.inviteeUserId, {
          title: 'Workspace invitation',
          body: `${context.inviterName} invited you to join ${context.workspaceName} as ${context.role}`,
          data: {
            type: 'INVITE_RECEIVED',
            workspaceId: context.workspaceId,
            workspaceName: context.workspaceName,
            role: context.role,
          },
        })
        .catch((e) =>
          this.logger.warn(
            `Push fan-out failed for user ${context.inviteeUserId}: ${e?.message ?? e}`,
          ),
        );
    }

    // Send email if we have an email address
    if (wantEmail && (context.inviteeType === 'email' || context.inviteeEmail)) {
      const email = context.inviteeEmail || context.inviteeIdentifier;
      // Wave-3 Drift #32 — universal email-quota enforcement.
      const quota = await this.mailService.checkEmailQuota(context.workspaceId);
      if (!quota.allowed) {
        this.logger.warn(`Skipping invitation email to ${email} — quota: ${quota.reason}`);
      } else {
        this.logger.log(`Sending invitation email to ${email}`);
        try {
          await this.mailService.sendWorkspaceInvitationEmail(email, {
            inviterName: context.inviterName,
            workspaceName: context.workspaceName,
            workspaceType: undefined,
            role: context.role,
            inviteUrl: context.inviteUrl,
            mobileDeepLink: context.mobileDeepLink,
            expiryDays: 7,
          });
          await this.mailService.incrementEmailUsage(context.workspaceId);
        } catch (e) {
          this.logger.error(`Failed to send invitation email: ${e.message}`);
        }
      }
    }

    // Send SMS for mobile invitations to new users
    if (wantSms && context.inviteeType === 'mobile' && !context.inviteeUserId) {
      const smsMessage = `You're invited to join ${context.workspaceName} on ManekHR. Accept here: ${context.inviteUrl}`;
      this.logger.log(`Sending SMS invitation to ${context.inviteeIdentifier}`);
      try {
        await this.smsService.send(context.inviteeIdentifier, smsMessage);
      } catch (e) {
        this.logger.error(`Failed to send SMS invitation: ${e.message}`);
      }
    }

    this.logger.log(`Invite notification dispatch completed for ${context.inviteeIdentifier}`);
  }
}
