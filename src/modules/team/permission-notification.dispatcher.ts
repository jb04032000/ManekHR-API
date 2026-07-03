import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { UserDevicesService } from '../user-devices/user-devices.service';

export interface PermissionNotificationArgs {
  workspaceId: string;
  /** Pre-fetched workspace doc — pass to avoid a redundant DB round-trip. */
  workspace?: Workspace & { name?: string; notificationPolicy?: WorkspaceNotificationPolicy };
  recipientUserId: string;
  recipientEmail?: string;
  recipientMobile?: string;
  affectedMemberName: string;
  affectedMemberId: string;
  actorName?: string;
  changeKind: 'overrides_updated' | 'role_changed';
  /** Human-readable one-liner for email / SMS body, e.g. "added 2 paths, removed 1". */
  diffSummary?: string;
}

interface WorkspaceNotificationPolicy {
  permissionChanges?: {
    enabled?: boolean;
    channels?: { inApp?: boolean; email?: boolean; sms?: boolean };
  };
}

export interface PermissionNotificationResult {
  inApp: boolean;
  email: boolean;
  sms: boolean;
}

// MSG91 DLT template ID for permission-change notifications.
// IMPORTANT: This is a placeholder ID — the template must be registered in
// the MSG91 dashboard before going live. Message:
// "Your permissions on {#var#} have been updated. Open zari360 to see the new access."
const DLT_TEMPLATE_PERMISSION_CHANGED = 'PERMISSION_CHANGED_PLACEHOLDER';

@Injectable()
export class PermissionNotificationDispatcher {
  private readonly logger = new Logger(PermissionNotificationDispatcher.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly mailService: MailService,
    private readonly smsService: SmsService,
    private readonly userDevicesService: UserDevicesService,
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>,
  ) {}

  /**
   * Dispatch a permission-change notification (override OR role swap) to the
   * affected member. Reads `workspace.notificationPolicy.permissionChanges`,
   * short-circuits if disabled, fans out per channel.
   *
   * Every channel is try/caught — dispatch failure MUST NEVER fail the
   * permission save. Returns a result object so callers can include
   * `notificationsDispatched` in audit meta.
   */
  async dispatch(args: PermissionNotificationArgs): Promise<PermissionNotificationResult> {
    const workspace =
      args.workspace ??
      ((await this.workspaceModel.findById(args.workspaceId).lean().exec()) as
        | (Workspace & { name?: string; notificationPolicy?: WorkspaceNotificationPolicy })
        | null);

    const policy = workspace?.notificationPolicy?.permissionChanges;
    if (!policy?.enabled) {
      return { inApp: false, email: false, sms: false };
    }

    const channels = policy.channels ?? { inApp: true, email: false, sms: false };
    const dispatched: PermissionNotificationResult = { inApp: false, email: false, sms: false };

    const wsName = (workspace as { name?: string } | null)?.name ?? 'a workspace';

    const titleByKind: Record<PermissionNotificationArgs['changeKind'], string> = {
      overrides_updated: 'Your permissions were updated',
      role_changed: 'Your role was changed',
    };

    const baseMessage = `An admin updated your access in ${wsName}.`;
    const category = args.changeKind === 'role_changed' ? 'ROLE_CHANGED' : 'PERMISSIONS_UPDATED';

    // ── In-app notification ───────────────────────────────────────────────────
    if (channels.inApp) {
      try {
        await this.notificationsService.createNotification(args.workspaceId, {
          recipientId: args.recipientUserId,
          type: 'info',
          title: titleByKind[args.changeKind],
          message: `${baseMessage}${args.diffSummary ? ' ' + args.diffSummary : ''}`,
          metadata: {
            category,
            workspaceId: args.workspaceId,
            teamMemberId: args.affectedMemberId,
            changeKind: args.changeKind,
          },
        });
        dispatched.inApp = true;
      } catch (e) {
        this.logger.error(
          `PermissionDispatcher in-app failed for member ${args.affectedMemberId}: ${(e as Error).message}`,
        );
      }

      // Mobile push — fire-and-forget; never block the permission save.
      void this.userDevicesService
        .pushUser(args.recipientUserId, {
          title: titleByKind[args.changeKind],
          body: baseMessage,
          data: { category, workspaceId: args.workspaceId, changeKind: args.changeKind },
        })
        .catch((e) =>
          this.logger.warn(
            `PermissionDispatcher push failed for user ${args.recipientUserId}: ${(e as Error).message}`,
          ),
        );
    }

    // ── Email notification ────────────────────────────────────────────────────
    if (channels.email && args.recipientEmail) {
      try {
        await this.mailService.sendPermissionUpdateEmail({
          recipientEmail: args.recipientEmail,
          workspaceName: wsName,
          actorName: args.actorName ?? 'An admin',
          changeKind: args.changeKind,
          diffSummary: args.diffSummary ?? '',
        });
        dispatched.email = true;
      } catch (e) {
        this.logger.error(
          `PermissionDispatcher email failed for ${args.recipientEmail}: ${(e as Error).message}`,
        );
      }
    }

    // ── SMS notification ──────────────────────────────────────────────────────
    if (channels.sms && args.recipientMobile) {
      try {
        await this.smsService.sendDltSms({
          workspaceId: args.workspaceId,
          mobile: args.recipientMobile,
          // Placeholder DLT template — must be registered in MSG91 dashboard
          // before going live (see DLT_TEMPLATE_PERMISSION_CHANGED constant above).
          templateId: DLT_TEMPLATE_PERMISSION_CHANGED,
          vars: { workspaceName: wsName },
        });
        dispatched.sms = true;
      } catch (e) {
        this.logger.error(
          `PermissionDispatcher SMS failed for member ${args.affectedMemberId}: ${(e as Error).message}`,
        );
      }
    }

    return dispatched;
  }
}
