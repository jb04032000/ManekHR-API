import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AttendanceDevice } from '../schemas/attendance-device.schema';
import { AttendanceDevicesService } from '../attendance-devices.service';
import { MailService } from '../../mail/mail.service';
import { ConfigService } from '@nestjs/config';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CronJobKey } from '../../../common/constants/cron.constants';

/**
 * Daily digest cron: sends an email to workspace owners and manage_devices
 * members for each workspace that has unmapped (deviceSerial, deviceUserId) pairs.
 *
 * Runs at 03:30 UTC (approximately 09:00 IST) — per D-07.
 * Skips workspaces with zero unassigned pairs.
 * One email per recipient per workspace per day (single cron trigger — D-07).
 */
@Injectable()
export class UnassignedDigestCron {
  private readonly logger = new Logger(UnassignedDigestCron.name);

  constructor(
    @InjectModel(AttendanceDevice.name)
    private readonly deviceModel: Model<AttendanceDevice>,
    @InjectModel('Workspace')
    private readonly workspaceModel: Model<any>,
    @InjectModel('WorkspaceMember')
    private readonly memberModel: Model<any>,
    private readonly devicesService: AttendanceDevicesService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Unassigned-device punch digest (D-07)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 03:30 UTC (~09:00 IST) - email owners/manage_devices members
   *              about unmapped (deviceSerial, deviceUserId) pairs.
   * Idempotent:  Effectively - relies on the single daily trigger (now enforced by
   *              the lock) for "one email per recipient per workspace per day"; no
   *              DB dedup, but blast radius is a digest email only.
   * Reads:       attendance_devices, workspaces, workspace_members
   * Writes:      none persistent; sends digest emails
   * Missed run:  Skips that day's digest (not retried across days by design).
   * Owner:       attendance-devices
   */
  @Cron('0 30 3 * * *')
  async sendDailyDigests(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.ATTENDANCE_UNASSIGNED_DIGEST, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    this.logger.log('[UnassignedDigestCron] Starting daily unassigned-punch digest...');

    // Find all workspace IDs that have at least one active device
    const wsIds: Types.ObjectId[] = await this.deviceModel
      .distinct('wsId', { status: 'active' })
      .exec();

    if (wsIds.length === 0) {
      this.logger.log('[UnassignedDigestCron] No active devices found — skipping.');
      return;
    }

    let digestsSent = 0;

    for (const wsId of wsIds) {
      try {
        const wsIdStr = wsId.toString();

        // Get unassigned (serial, deviceUserId) pairs for this workspace
        const unassigned = await this.devicesService.getUnassignedPunches(wsIdStr);

        // Skip workspaces with 0 unassigned pairs (D-07)
        if (!unassigned || unassigned.length === 0) continue;

        const totalCount = unassigned.length; // distinct pairs, not raw event count

        // Fetch workspace name and ownerId
        const ws = await this.workspaceModel.findById(wsIdStr).select('name ownerId').lean().exec();
        if (!ws) continue;

        // Resolve recipients: owner + members with attendance:manage_devices permission (D-08)
        const members = await this.memberModel
          .find({ workspaceId: new Types.ObjectId(wsIdStr), status: 'active' })
          .populate('roleId', 'permissions')
          .populate('userId', 'email name')
          .lean()
          .exec();

        // Map: userId string → { email, name } — deduplicates recipients
        const recipientMap = new Map<string, { email: string; name: string }>();

        // Always include the workspace owner
        const ownerMember = members.find(
          (m: any) => m.userId && m.userId._id.toString() === ws.ownerId.toString(),
        );
        if (ownerMember?.userId) {
          recipientMap.set(ws.ownerId.toString(), {
            email: ownerMember.userId.email,
            name: ownerMember.userId.name,
          });
        }

        // Add members with attendance:manage_devices permission
        for (const m of members as any[]) {
          if (!m.userId) continue;
          const perms: Array<{ module: string; actions: string[] }> = m.roleId?.permissions ?? [];
          if (
            perms.some((p) => p.module === 'attendance' && p.actions?.includes('manage_devices'))
          ) {
            recipientMap.set(m.userId._id.toString(), {
              email: m.userId.email,
              name: m.userId.name,
            });
          }
        }

        if (recipientMap.size === 0) {
          this.logger.log(
            `[UnassignedDigestCron] No recipients found for ws=${wsIdStr} — skipping`,
          );
          continue;
        }

        const webAppUrl =
          this.configService.get<string>('app.webAppUrl') ?? 'https://app.manekhr.in';
        const manageUrl = `${webAppUrl}/dashboard/attendance/unassigned`;

        // Send digest email to each recipient — failure for one does not stop others (T-B-04-03)
        for (const recipient of recipientMap.values()) {
          await this.mailService
            .sendUnassignedDigestEmail(recipient, {
              wsName: ws.name,
              unassignedCount: totalCount,
              manageUrl,
            })
            .catch((err: any) => {
              this.logger.warn(
                `[UnassignedDigestCron] Email to ${recipient.email} failed for ws=${wsIdStr}: ${err?.message}`,
              );
            });
        }

        this.logger.log(
          `[UnassignedDigestCron] Sent digest for ws=${wsIdStr}, ` +
            `${totalCount} unassigned pairs, ${recipientMap.size} recipient(s)`,
        );
        digestsSent++;
      } catch (err: any) {
        this.logger.error(
          `[UnassignedDigestCron] Failed processing ws=${String(wsId)}: ${err?.message}`,
        );
      }
    }

    this.logger.log(
      `[UnassignedDigestCron] Daily digest complete — sent for ${digestsSent}/${wsIds.length} workspace(s).`,
    );
  }
}
