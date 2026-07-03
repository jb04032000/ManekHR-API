import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { Bill } from '../schemas/bill.schema';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CRON_TIMEZONES } from '../../../common/constants/cron.constants';
import { env } from '../../../config/env';

/**
 * HARD statutory retention floor (Finance/Bills hardening, spec D4).
 *
 * The LEGAL MINIMUM window for a destructive, irreversible purge — a CODE
 * CONSTANT, not an env knob. Neither the `BILLS_RETENTION_FINANCE_YEARS` env
 * value nor a per-workspace override can drop the window below this; both can
 * only EXTEND retention (keep records longer), never shorten it. An operator
 * setting BILLS_RETENTION_FINANCE_YEARS=1 therefore still yields an 8-year
 * cutoff — the floor wins.
 *
 *   - 8 years — Companies Act 2013 s.128 keeps books of account for 8 years.
 *     CGST Rule 56 (6y from the annual-return due date) and IT Act s.44AA (6y)
 *     are shorter; 8y dominates and is the binding floor for the AP/AR books.
 *
 * See docs/compliance/DATA-MAP-AND-RETENTION.md §2 + the Finance/Bills spec D4.
 */
export const STATUTORY_FINANCE_FLOOR_YEARS = 8;

/**
 * BillsRetentionPurgeCron — Finance/Bills hardening Pillar 1 (spec C1-D).
 *
 * The SYSTEM-ONLY permanent-purge path (DATA-MAP §1b / §3 step 6). Hard-erases
 * ONLY SOFT-DELETED legacy `Bill` rows whose retention window has lapsed — never
 * as a user action, and never an active (non-deleted) bill. This is the only
 * place in the Bills module that physically deletes Bucket-B data. Mirrors the
 * salary + attendance retention purge crons exactly.
 *
 * CRITICAL scope guard (spec C1-D / D5): this cron NEVER touches LedgerEntry,
 * posted PurchaseBill / ExpenseVoucher / PaymentOut, TdsTracker, or
 * CapitalGoodsItcSchedule. Those are double-entry accounting records whose
 * individual deletion would corrupt the trial balance; they are purged only at
 * the WORKSPACE level after retention (Workspaces hardening pass #7). This cron
 * deletes ONLY soft-deleted legacy `Bill` rows (the lightweight AP/AR tracker,
 * which has no ledger linkage).
 *
 * Safety rails:
 *   - OFF by default (env.billsRetention.enabled, sharing the master
 *     RUN_RETENTION_PURGE_ON_SCHEDULE switch, default false). With the flag off
 *     the cron logs and exits — prod never auto-purges until the owner + CA
 *     enable it (AC-1.4).
 *   - Window = max(env value, HARD floor constant). The HARD floor is the legal
 *     minimum: an env knob set below the floor cannot shorten the window
 *     (AC-1.8). There is no per-workspace bills-retention override surface today
 *     (the 8y Companies-Act floor is uniform), so the window is workspace-
 *     independent; the per-workspace loop is kept for symmetry with the salary
 *     purge so a future override slots in without restructuring.
 *   - Cutoff is anchored on `deletedAt` (the soft-delete timestamp), so a bill
 *     is purged 8 years after it was REMOVED, not after it was created. A bill
 *     soft-deleted yesterday is retained a full 8 years regardless of its
 *     create date — fail-safe (a still-recent removal is never erased).
 *   - ONLY `isDeleted: true` rows are eligible — an active bill is never purged.
 *   - Single-flight (Redis) so a multi-worker deploy purges once per day.
 *
 * Dependency note: reads workspaces; hard-deletes ONLY soft-deleted rows of the
 * `bills` collection it owns. No cross-module write; no ledger/voucher touch.
 */
@Injectable()
export class BillsRetentionPurgeCron {
  private readonly logger = new Logger(BillsRetentionPurgeCron.name);

  constructor(
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>,
    @InjectModel(Bill.name) private readonly billModel: Model<Bill>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT — Finance/Bills retention purge (spec C1-D)
   * Execution:   @Cron + Redis single-flight per day. Disabled unless
   *              RUN_RETENTION_PURGE_ON_SCHEDULE=true.
   * Schedule:    daily 04:00 UTC (clear of the salary purge 03:30 + the
   *              attendance purge 03:45).
   * Idempotent:  YES — deletes only soft-deleted rows already past the window;
   *              a second run finds nothing new for the same day.
   * Reads:       workspaces
   * Writes:      HARD-DELETE of soft-deleted legacy Bill rows past the 8y floor
   *              (Bucket B). NEVER ledger entries or posted Finance vouchers.
   * Owner:       bills (legacy AP/AR tracker)
   */
  @Cron('0 4 * * *', { timeZone: CRON_TIMEZONES.UTC })
  async handlePurge(): Promise<void> {
    if (!env.billsRetention.enabled) {
      this.logger.debug(
        'Finance/Bills retention purge disabled (RUN_RETENTION_PURGE_ON_SCHEDULE != true); skipping.',
      );
      return;
    }
    await this.singleFlight.runExclusive('bills.retention_purge', dayBucket(), () =>
      this.process(),
    );
  }

  private cutoff(years: number): Date {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d;
  }

  private async process(): Promise<void> {
    this.logger.log('Finance/Bills retention purge starting...');

    // Window = max(env value, HARD floor constant). The HARD floor is the legal
    // minimum: an env knob set below the floor cannot shorten it (AC-1.8).
    const financeYears = Math.max(env.billsRetention.financeYears, STATUTORY_FINANCE_FLOOR_YEARS);
    const financeCutoff = this.cutoff(financeYears);

    const workspaces = await this.workspaceModel.find({}).select('_id name').lean().exec();

    let totalDeleted = 0;

    for (const ws of workspaces) {
      const workspaceId = String(ws._id);
      try {
        const wsOid = new Types.ObjectId(workspaceId);

        // Bucket B — soft-deleted Finance/Bill record past retention window; no
        // statutory value remaining; Companies Act 2013 s.128 / CGST Rule 56 /
        // IT Act s.44AA floor = 8y. ONLY isDeleted:true rows whose deletedAt is
        // older than the window are erased — an active bill is never touched, and
        // NO ledger entry or posted Finance voucher is ever reached by this cron.
        const res = await this.billModel.deleteMany({
          workspaceId: wsOid,
          isDeleted: true,
          deletedAt: { $lt: financeCutoff },
        });

        const deleted = res.deletedCount ?? 0;
        if (deleted > 0) {
          totalDeleted += deleted;
          this.logger.log(
            `Finance/Bills retention purge ws="${ws.name ?? workspaceId}" deleted=${deleted} ` +
              `(financeYears=${financeYears})`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Finance/Bills retention purge failed for workspace ${workspaceId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }

    this.logger.log(`Finance/Bills retention purge complete. Total rows deleted=${totalDeleted}.`);
  }
}
