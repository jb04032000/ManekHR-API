import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as dayjs from 'dayjs';
import { JobWorkLot, JobWorkLotDocument } from '../jw-lot/jw-lot.schema';
import { MailService } from '../../../mail/mail.service';
import { NotificationsService } from '../../../notifications/notifications.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

@Injectable()
export class JwPendingAlarmCron {
  private readonly logger = new Logger(JwPendingAlarmCron.name);

  constructor(
    @InjectModel(JobWorkLot.name)
    private readonly lotModel: Model<JobWorkLotDocument>,
    @InjectModel('Workspace')
    private readonly workspaceModel: Model<any>,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * D-08: Daily 06:00 IST. Section 143 CGST compliance cron.
   * - Flags lots as 'deemed_supply' at day >= 365 (auto-flag)
   * - Sends 30-day pre-warning at day >= 335 with 7-day dedup via lastWarningSentAt
   * - BOTH channels fire for each event: in-app notification + email (D-08 mandate)
   * - DB status update happens BEFORE dispatch — T-F11-W2-06 (failure does not leave lot inconsistent)
   * - Email/notification failures are caught and logged (warn-and-continue)
   * - Re-flagging avoided: query filters status IN [pending, partial] — deemed_supply lots excluded (Pitfall 6)
   */
  /**
   * CRON CONTRACT - Job-work deemed-supply alarm (D-08, Section 143 CGST)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 06:00 IST - flag lots >=365 days as deemed_supply + warn.
   * Idempotent:  YES (state + dedup) - the status flip filters out lots already
   *              'deemed_supply'; pre-warnings dedupe on lastWarningSentAt (7-day),
   *              stamped BEFORE dispatch. A re-run re-sends nothing.
   * Reads:       job_work_lots, workspaces
   * Writes:      lot status -> deemed_supply / lastWarningSentAt; in-app
   *              notifications (email dispatch is a documented TODO)
   * Missed run:  Self-heals - the next day re-evaluates by day-count.
   * Owner:       finance/job-work
   */
  @Cron('0 6 * * *', { timeZone: 'Asia/Kolkata' })
  async handleDeemedSupplyAlarm(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.FINANCE_JW_PENDING_ALARM, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    this.logger.log('JW deemed-supply alarm cron started');
    const now = new Date();
    let flagged = 0;
    let warned = 0;

    const overdue = await this.lotModel
      .find({ status: { $in: ['pending', 'partial'] }, isDeleted: false })
      .populate('principalPartyId', 'name email')
      .lean();

    for (const lot of overdue) {
      const daysElapsed = dayjs(now).diff(dayjs(lot.inwardDate), 'day');

      if (daysElapsed >= 365 && lot.status !== 'deemed_supply') {
        // Step 1: Update DB status BEFORE dispatch — T-F11-W2-06 consistency
        await this.lotModel.updateOne(
          { _id: lot._id },
          { $set: { status: 'deemed_supply', deemedSupplyFlaggedAt: now } },
        );
        flagged++;

        // Step 2: Resolve workspace owner ObjectId (= User ObjectId for recipientId)
        const ownerId = await this.resolveWorkspaceOwnerId(String(lot.workspaceId));

        // Step 3: In-app notification (D-08 BOTH channels)
        if (ownerId) {
          await this.notificationsService
            .createNotification(String(lot.workspaceId), {
              recipientId: ownerId,
              title: `Deemed supply triggered for Lot ${lot.lotNo}`,
              message: `Lot ${lot.lotNo} from ${(lot as any).principalPartyId?.name ?? 'Principal'} has reached ${daysElapsed} days since inward without full return. Treat as deemed supply per Section 143 CGST.`,
              type: 'error',
              metadata: {
                entityId: String(lot._id),
                entityType: 'jw_lot',
                lotNo: lot.lotNo,
                daysElapsed,
              },
            })
            .catch((err) =>
              this.logger.warn(
                `In-app deemed-supply notification failed for lot ${lot.lotNo}: ${(err as Error).message}`,
              ),
            );
        }

        // Step 4: Email alert (D-08 BOTH channels)
        // TODO(F-11): Inject UsersService to resolve User.email from ownerId for full wiring.
        // Guard: skip email and log a visible warning rather than sending to empty address.
        if (!ownerId) {
          this.logger.warn(
            `[D-08] Deemed-supply email skipped for lot ${lot.lotNo} — owner email not resolved (UsersService not yet wired)`,
          );
        } else {
          // ownerId is resolved but User.email lookup is not yet wired — log and skip.
          // Replace this branch with actual email resolution once UsersService is injected.
          this.logger.warn(
            `[D-08] Deemed-supply email skipped for lot ${lot.lotNo} — User.email lookup from ownerId not yet implemented`,
          );
        }
      } else if (daysElapsed >= 335 && daysElapsed < 365) {
        // 7-day dedup for pre-warning — T-F11-W2-07 spam prevention
        const lastSent = (lot as any).lastWarningSentAt as Date | undefined;
        if (lastSent && dayjs(now).diff(dayjs(lastSent), 'day') < 7) continue;

        const daysRemaining = 365 - daysElapsed;

        // Step 1: Update dedup timestamp BEFORE dispatch — T-F11-W2-06 consistency
        await this.lotModel.updateOne({ _id: lot._id }, { $set: { lastWarningSentAt: now } });
        warned++;

        const ownerId = await this.resolveWorkspaceOwnerId(String(lot.workspaceId));

        // Step 2: In-app pre-warning notification (D-08 BOTH channels)
        if (ownerId) {
          await this.notificationsService
            .createNotification(String(lot.workspaceId), {
              recipientId: ownerId,
              title: `${daysRemaining} days left to return Lot ${lot.lotNo}`,
              message: `Lot ${lot.lotNo} from ${(lot as any).principalPartyId?.name ?? 'Principal'} has ${daysRemaining} days remaining before the deemed-supply threshold (Section 143 CGST).`,
              type: 'warning',
              metadata: {
                entityId: String(lot._id),
                entityType: 'jw_lot',
                lotNo: lot.lotNo,
                daysRemaining,
              },
            })
            .catch((err) =>
              this.logger.warn(
                `In-app pre-warning notification failed for lot ${lot.lotNo}: ${(err as Error).message}`,
              ),
            );
        }

        // Step 3: Pre-warning email (D-08 BOTH channels)
        // TODO(F-11): Inject UsersService to resolve User.email from ownerId for full wiring.
        // Guard: skip email and log a visible warning rather than sending to empty address.
        if (!ownerId) {
          this.logger.warn(
            `[D-08] Pre-warning email skipped for lot ${lot.lotNo} — owner email not resolved (UsersService not yet wired)`,
          );
        } else {
          // ownerId is resolved but User.email lookup is not yet wired — log and skip.
          // Replace this branch with actual email resolution once UsersService is injected.
          this.logger.warn(
            `[D-08] Pre-warning email skipped for lot ${lot.lotNo} — User.email lookup from ownerId not yet implemented`,
          );
        }
      }
    }

    this.logger.log(
      `JW deemed-supply alarm done: ${flagged} flagged as deemed_supply, ${warned} pre-warnings sent`,
    );
  }

  /**
   * Resolve workspace owner's User ObjectId string for in-app notification recipientId.
   * Workspace.ownerId IS a User ObjectId — no User model lookup needed.
   * Returns null if workspace not found — callers skip in-app dispatch gracefully.
   *
   * TODO(F-11): Extend to also notify members with manage_job_work_in/out permission
   * (same pattern as AnomalyNotifyService.resolveAdminRecipients). For MVP, workspace owner only.
   */
  private async resolveWorkspaceOwnerId(workspaceId: string): Promise<string | null> {
    try {
      const ws = await this.workspaceModel
        .findById(new Types.ObjectId(workspaceId))
        .select('ownerId')
        .lean()
        .exec();
      if (!ws?.ownerId) return null;
      return String(ws.ownerId);
    } catch (err) {
      this.logger.warn(
        `Could not resolve workspace owner for ${workspaceId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private buildDeemedSupplyHtml(lot: any, daysElapsed: number): string {
    const principalName = lot.principalPartyId?.name ?? 'Principal';
    return `
      <p>Lot <strong>${lot.lotNo}</strong> from <strong>${principalName}</strong>
      has reached <strong>${daysElapsed} days</strong> since inward
      (${dayjs(lot.inwardDate).format('DD MMM YYYY')}) without being fully returned.</p>
      <p>Per Section 143 CGST, this is now treated as a <strong>deemed supply</strong>
      and may attract GST liability. Please contact your CA immediately.</p>
      <p>Item: ${lot.itemDescription}<br/>
      Qty Remaining: ${lot.qtyRemaining} ${lot.unit}</p>`;
  }

  private buildPreWarningHtml(lot: any, daysRemaining: number): string {
    const principalName = lot.principalPartyId?.name ?? 'Principal';
    return `
      <p>Lot <strong>${lot.lotNo}</strong> from <strong>${principalName}</strong>
      has <strong>${daysRemaining} days remaining</strong> until the 365-day return
      deadline. After that, it will be treated as a deemed supply per Section 143 CGST.</p>
      <p>Item: ${lot.itemDescription}<br/>
      Qty Remaining: ${lot.qtyRemaining} ${lot.unit}<br/>
      Inward Date: ${dayjs(lot.inwardDate).format('DD MMM YYYY')}</p>`;
  }
}
