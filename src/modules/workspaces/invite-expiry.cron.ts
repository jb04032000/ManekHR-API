import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { hourBucket } from '../../common/scheduler/period-key';
import { WorkspaceMember } from './schemas/workspace-member.schema';
import { Workspace } from './schemas/workspace.schema';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * P2.6 (2026-05-15) — hourly sweep of expired invite rows.
 *
 * Finds every WorkspaceMember row where:
 *   - status === 'invited'
 *   - inviteExpiry < now
 *   - expiryNotifiedAt is unset (dedup — avoids re-notifying every tick)
 *
 * For each row, emits INVITE_EXPIRED notifications to:
 *   - the grantor (`member.invitedBy`) — always
 *   - the invitee (`member.userId`) — only when bound (warm invites)
 *
 * Then stamps `expiryNotifiedAt = now` so the row is skipped on the next
 * tick. The row's `status` stays `'invited'` per the P2.6 locked decision
 * (no `'expired'` enum value) — FE already derives the expired visual
 * from `inviteExpiry < now`.
 *
 * Failure for one row logs + continues; one bad row must not block the
 * rest of the batch.
 */
@Injectable()
export class InviteExpiryCron {
  private readonly logger = new Logger(InviteExpiryCron.name);

  constructor(
    @InjectModel(WorkspaceMember.name)
    private readonly memberModel: Model<WorkspaceMember>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly notificationsService: NotificationsService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Invite expiry sweep
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per hour. See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly (IST registration) - notify on expired pending invites.
   * Idempotent:  YES - naturally idempotent via a dedup stamp: the query excludes
   *              rows with expiryNotifiedAt set, and each processed row is stamped
   *              expiryNotifiedAt = now, so a re-run notifies nobody twice. Tier C.
   * Reads:       workspace_members (status=invited, expired, not yet notified), workspaces
   * Writes:      sets WorkspaceMember.expiryNotifiedAt; creates INVITE_EXPIRED
   *              notifications to grantor + bound invitee
   * Missed run:  Self-heals - the next hour notifies every still-un-notified expired
   *              invite (capped at 200/run; a large backlog drains over a few runs).
   * Owner:       workspaces
   */
  @Cron(CRON_SCHEDULES.EVERY_HOUR, {
    name: CronJobKey.INVITE_EXPIRY_SWEEP,
    timeZone: CRON_TIMEZONES.IST,
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.INVITE_EXPIRY_SWEEP, hourBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const startedAt = Date.now();
    const now = new Date();

    let scanned = 0;
    let notifiedGrantor = 0;
    let notifiedInvitee = 0;
    let failed = 0;

    try {
      const expired = await this.memberModel
        .find({
          status: 'invited',
          inviteExpiry: { $lt: now },
          expiryNotifiedAt: { $exists: false },
        })
        .limit(200)
        .exec();

      for (const m of expired) {
        scanned++;
        try {
          const ws = await this.workspaceModel.findById(m.workspaceId).lean().exec();
          const workspaceName = (ws as { name?: string } | null)?.name ?? 'your workspace';

          if (m.invitedBy) {
            await this.notificationsService.createNotification(String(m.workspaceId), {
              recipientId: String(m.invitedBy),
              type: 'warning',
              title: 'Invitation expired',
              message: `An invitation to ${workspaceName} expired without being accepted.`,
              metadata: {
                category: 'INVITE_EXPIRED',
                workspaceId: String(m.workspaceId),
                workspaceMemberId: String(m._id),
              },
            });
            notifiedGrantor++;
          }

          if (m.userId) {
            await this.notificationsService.createNotification(String(m.workspaceId), {
              recipientId: String(m.userId),
              type: 'warning',
              title: 'Invitation expired',
              message: `Your invitation to join ${workspaceName} expired.`,
              metadata: {
                category: 'INVITE_EXPIRED',
                workspaceId: String(m.workspaceId),
                workspaceMemberId: String(m._id),
              },
            });
            notifiedInvitee++;
          }

          m.expiryNotifiedAt = now;
          await m.save();
        } catch (err: unknown) {
          failed++;
          this.logger.warn(
            `[InviteExpiryCron] member=${String(m._id)} ws=${String(m.workspaceId)} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err: unknown) {
      this.logger.error(
        `[InviteExpiryCron] run aborted: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const durationMs = Date.now() - startedAt;
    if (scanned > 0 || failed > 0) {
      this.logger.log(
        `[InviteExpiryCron] complete — scanned=${scanned} grantor=${notifiedGrantor} invitee=${notifiedInvitee} failed=${failed} durationMs=${durationMs}`,
      );
    }
  }
}
