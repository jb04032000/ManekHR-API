import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdCampaign } from '../schemas/ad-campaign.schema';
import { AdWalletLedger } from '../schemas/ad-wallet-ledger.schema';
import { AdvertiserWallet } from '../schemas/advertiser-wallet.schema';
import { WalletService } from '../services/wallet.service';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

/**
 * ReconcileCron - runs nightly at 03:00 UTC.
 *
 * For each campaign that is still marked `active` but whose `endAt` has
 * already passed, the cron:
 *  1. Computes the unspent reserve = totalBudget - budgetSpent, clamped to 0.
 *  2. If the gap is positive, calls WalletService.release to return the
 *     unspent credits back to the advertiser's spendable balance.
 *  3. Marks the campaign `completed` and saves.
 *
 * The public `tick(nowMs)` method is extracted from `run()` so tests can
 * call it directly without triggering the @Cron decorator or requiring a
 * full NestJS module context.
 */

// ---------------------------------------------------------------------------
// Pure helper - exported for direct unit testing
// ---------------------------------------------------------------------------

export interface ReconcileInput {
  status: string;
  reservedForCampaign: number;
  confirmedSpend: number;
}

/**
 * Returns the amount to release back to the wallet for a campaign that has
 * ended. Returns 0 for campaigns that are still active or pending review
 * (nothing to reconcile yet). Clamps to 0 so over-spent campaigns never
 * produce a negative release.
 */
export function reconcileAmount(input: ReconcileInput): number {
  if (input.status === 'active' || input.status === 'pending_review') return 0;
  return Math.max(0, input.reservedForCampaign - input.confirmedSpend);
}

// ---------------------------------------------------------------------------
// Reserved-integrity reconstruction (claimed-but-never-debited crash window)
// ---------------------------------------------------------------------------

/** Minimal ledger row shape the reserved-drift reconstruction needs. */
export interface LedgerReservedRow {
  type: string;
  amount: number;
}

/**
 * How a single ledger row moves the wallet's `reserved` bucket. The ledger
 * `amount` sign convention (see wallet.service): reserve = -X (reserved +X),
 * debit = -X (reserved -X), release = +X (reserved -X). topup / grant /
 * grant_expire never touch reserved. `adjustment` is signed per correction and
 * is NOT reconstructable here, so owners with any adjustment row are excluded
 * from the check by the caller rather than guessed at.
 */
export function reservedDelta(type: string, amount: number): number {
  switch (type) {
    case 'reserve':
      return -amount; // amount < 0 -> reserved increases by |amount|
    case 'debit':
      return amount; // amount < 0 -> reserved decreases by |amount|
    case 'release':
      return -amount; // amount > 0 -> reserved decreases by amount
    default:
      return 0; // topup / grant / grant_expire / adjustment: no reserved effect
  }
}

/** The ledger-implied reserved balance for one owner (sum of per-row deltas). */
export function expectedReservedFromLedger(rows: LedgerReservedRow[]): number {
  return rows.reduce((acc, r) => acc + reservedDelta(r.type, r.amount), 0);
}

/**
 * Compare an owner's actual wallet `reserved` to the ledger-implied value.
 * Returns the signed drift (actual - expected). A POSITIVE drift is the
 * fingerprint of the claimed-but-never-debited crash window: a debit ledger row
 * was inserted (so `expected` was reduced) but the guarded `reserved` decrement
 * never ran (so `actual` was not), leaving actual > expected. Negative drift is
 * the opposite (a decrement with no ledger row) and is reported too. Values
 * within `epsilon` are treated as clean (float-noise tolerant).
 */
export function reservedDrift(actualReserved: number, expectedReserved: number): number {
  return actualReserved - expectedReserved;
}

// ---------------------------------------------------------------------------
// Cron class
// ---------------------------------------------------------------------------

/** Tolerance for reserved-drift comparison (credits are integer paise; this
 *  guards against any accidental float noise from aggregation). */
const RESERVED_DRIFT_EPSILON = 0.5;
/** Max drifted owners listed in the report (the rest are counted, not listed). */
const DRIFT_SAMPLE = 25;

export interface ReservedDriftSummary {
  /** Owners whose ledger could be reconstructed and was compared. */
  ownersChecked: number;
  /** Owners skipped because they carry an `adjustment` row (unreconstructable). */
  ownersSkipped: number;
  /** actual > expected: the claimed-but-never-debited crash-window fingerprint. */
  claimedNotDebited: number;
  /** actual < expected: a reserved decrement with no matching ledger row. */
  underReserved: number;
}

@Injectable()
export class ReconcileCron {
  private readonly logger = new Logger(ReconcileCron.name);

  constructor(
    @InjectModel(AdCampaign.name) private readonly campaignModel: Model<AdCampaign>,
    private readonly wallet: WalletService,
    private readonly singleFlight: SingleFlightService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    // Reserved-drift detection deps. Trailing + @Optional so the positional
    // unit-test constructors (2-arg / 4-arg) keep working; production DI injects
    // them by @InjectModel metadata regardless of position. detectReservedDrift
    // no-ops when they are absent (a unit test that does not exercise it).
    @Optional()
    @InjectModel(AdWalletLedger.name)
    private readonly ledgerModel?: Model<AdWalletLedger>,
    @Optional()
    @InjectModel(AdvertiserWallet.name)
    private readonly walletModel?: Model<AdvertiserWallet>,
  ) {}

  /**
   * CRON CONTRACT - Ads campaign reconcile
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per day. See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 03:00 UTC - release unspent reserve for campaigns whose
   *              endAt has passed and mark them completed.
   * Idempotent:  YES (predicate state-flip) - the query selects only
   *              { status: 'active', endAt <= now }; each campaign is flipped to
   *              'completed' after its release, so a re-run no longer matches it and
   *              the release fires once. WalletService.release is itself guarded
   *              (decrements only when reserved >= amount). Residual: a crash
   *              between release and the status save could re-release on the next
   *              run - same crash-window class as the deferred finance cursor crons,
   *              not closed here (Tier B, no claim marker added to the money path).
   * Reads:       ad_campaigns
   * Writes:      ad_campaigns.status; releases reserved credits via WalletService
   *              (wallet balance + ledger); emits ads.campaign_completed to PostHog
   * Missed run:  A skipped day delays release/completion until the next run, which
   *              picks up every still-active expired campaign (self-healing).
   * Owner:       connect/ads
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: CronJobKey.ADS_RECONCILE })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.ADS_RECONCILE, dayBucket(), () =>
      this.tick(Date.now()),
    );
  }

  async tick(nowMs: number): Promise<void> {
    const ended = await this.campaignModel.find({
      status: 'active',
      endAt: { $lte: new Date(nowMs) },
    });

    for (const c of ended) {
      const gap = reconcileAmount({
        status: 'completed',
        reservedForCampaign: c.totalBudget,
        confirmedSpend: c.budgetSpent,
      });

      if (gap > 0) {
        await this.wallet.release(String(c.ownerUserId), gap, String(c._id));
      }

      c.status = 'completed';
      await c.save();

      this.posthog?.capture({
        distinctId: String(c.ownerUserId),
        event: 'ads.campaign_completed',
        properties: {
          campaignId: String(c._id),
          released: gap,
        },
      });
    }

    // Report-only second pass: surface reserved-balance drift, including the
    // claimed-but-never-debited crash window documented on WalletService.debit.
    // Never mutates wallets/ledger -- detection + alert only.
    await this.detectReservedDrift();
  }

  /**
   * REPORT-ONLY reserved-integrity check. Reconstructs each advertiser's
   * ledger-implied `reserved` (reserve/debit/release deltas) and compares it to
   * the wallet's actual `reserved`. A positive drift (actual > expected) is the
   * fingerprint of a debit that CLAIMED its idempotency-key ledger row but died
   * before the guarded `reserved` decrement (WalletService.debit step 1 done,
   * step 2 skipped) -- the documented crash window. Owners carrying an
   * `adjustment` ledger row are skipped (their reserved is not reconstructable
   * from the convention alone). Logs a structured warning + emits a PostHog
   * metric; it does NOT auto-correct anything.
   */
  async detectReservedDrift(): Promise<ReservedDriftSummary> {
    const summary: ReservedDriftSummary = {
      ownersChecked: 0,
      ownersSkipped: 0,
      claimedNotDebited: 0,
      underReserved: 0,
    };

    // Models are injected in production but optional for positional unit tests;
    // without them there is nothing to reconstruct, so this is a clean no-op.
    if (!this.ledgerModel || !this.walletModel) return summary;
    const ledgerModel = this.ledgerModel;
    const walletModel = this.walletModel;

    // Per-owner ledger reconstruction in one server-side $group: the reserved
    // delta sum + whether any adjustment row exists (which makes it unsafe).
    const rows = await ledgerModel.aggregate([
      {
        $group: {
          _id: '$ownerUserId',
          expectedReserved: {
            $sum: {
              $switch: {
                branches: [
                  { case: { $eq: ['$type', 'reserve'] }, then: { $multiply: ['$amount', -1] } },
                  { case: { $eq: ['$type', 'debit'] }, then: '$amount' },
                  { case: { $eq: ['$type', 'release'] }, then: { $multiply: ['$amount', -1] } },
                ],
                default: 0,
              },
            },
          },
          hasAdjustment: {
            $max: { $cond: [{ $eq: ['$type', 'adjustment'] }, 1, 0] },
          },
        },
      },
    ]);

    if (rows.length === 0) return summary;

    // Actual reserved per owner, keyed by id string.
    const ownerIds = rows.map((r) => r._id);
    const wallets = (await walletModel
      .find({ ownerUserId: { $in: ownerIds } })
      .select('ownerUserId reserved')
      .lean()
      .exec()) as unknown as Array<{ ownerUserId: unknown; reserved?: number }>;
    const reservedByOwner = new Map<string, number>(
      wallets.map((w) => [String(w.ownerUserId), w.reserved ?? 0]),
    );

    const claimedHints: string[] = [];
    const underHints: string[] = [];
    for (const row of rows) {
      if (row.hasAdjustment) {
        summary.ownersSkipped += 1;
        continue;
      }
      summary.ownersChecked += 1;
      const ownerKey = String(row._id);
      const actual = reservedByOwner.get(ownerKey) ?? 0;
      const drift = reservedDrift(actual, row.expectedReserved);
      if (Math.abs(drift) <= RESERVED_DRIFT_EPSILON) continue;
      // Owner id last-6 only for the log (correlation without dumping full ids).
      const hint = ownerKey.slice(-6);
      if (drift > 0) {
        summary.claimedNotDebited += 1;
        if (claimedHints.length < DRIFT_SAMPLE) claimedHints.push(`${hint}:+${drift}`);
      } else {
        summary.underReserved += 1;
        if (underHints.length < DRIFT_SAMPLE) underHints.push(`${hint}:${drift}`);
      }
    }

    const drifted = summary.claimedNotDebited + summary.underReserved;
    const line =
      `ads wallet reserved-drift: checked ${summary.ownersChecked} owners ` +
      `(skipped ${summary.ownersSkipped} w/ adjustments); ` +
      `claimedNotDebited=${summary.claimedNotDebited} underReserved=${summary.underReserved}`;
    if (drifted > 0) {
      this.logger.warn(
        `${line}; claimed[${claimedHints.join(', ')}]; under[${underHints.join(', ')}]`,
      );
    } else {
      this.logger.log(line);
    }

    this.posthog?.capture({
      distinctId: 'system',
      event: 'ads.reserved_drift_scan',
      properties: {
        ownersChecked: summary.ownersChecked,
        ownersSkipped: summary.ownersSkipped,
        claimedNotDebited: summary.claimedNotDebited,
        underReserved: summary.underReserved,
      },
    });

    return summary;
  }
}
