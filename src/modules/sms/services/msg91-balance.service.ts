import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { env } from '../../../config/env';
import { Msg91WalletSnapshot } from '../schemas/msg91-wallet-snapshot.schema';
import { SmsDispatchLog } from '../schemas/sms-dispatch-log.schema';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { hourBucket } from '../../../common/scheduler/period-key';
import { CronJobKey } from '../../../common/constants/cron.constants';

/**
 * Wave 8 — MSG91 wallet balance poller + ops alert.
 *
 * Hourly cron polls the MSG91 balance API + persists a snapshot. Computes
 * 30-day burn from `SmsDispatchLog.providerCostPaise` and alerts ops below
 * thresholds:
 *   - WARN  → balance < (30dAvgDailyBurn × 5)   (~5 days runway)
 *   - ALARM → balance < (30dAvgDailyBurn × 1)   (<1 day runway)
 *
 * NO auto-charge — manual top-up only via admin dashboard (decision N7).
 */
@Injectable()
export class Msg91BalanceService {
  private readonly logger = new Logger(Msg91BalanceService.name);
  private readonly balanceEndpoint = 'https://control.msg91.com/api/v5/wallet/balance';

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Msg91WalletSnapshot.name)
    private readonly snapshotModel: Model<Msg91WalletSnapshot>,
    @InjectModel(SmsDispatchLog.name)
    private readonly dispatchLogModel: Model<SmsDispatchLog>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - MSG91 wallet balance poll + ops alert
   * Execution:   @Cron gated to worker role + Redis single-flight per hour.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly - poll balance, persist a snapshot, alert ops if low.
   * Idempotent:  Effectively - the snapshot is a per-poll time-series append (one
   *              row per hourly tick under single-flight); the low-balance alert
   *              is throttled separately (OPS_ALERT_THROTTLE_DAYS). A double-fire
   *              is prevented by the lock; a snapshot row is monitoring data only.
   * Reads:       MSG91 balance API, SmsDispatchLog (30d burn)
   * Writes:      msg91_wallet_snapshots; sends ops low-balance alert (throttled)
   * Missed run:  Self-heals - the next hour polls again.
   * Owner:       sms
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runHourlyPoll(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.MSG91_BALANCE_POLL, hourBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const balancePaise = await this.fetchWalletBalance();
      await this.snapshotModel.create({
        provider: 'msg91',
        balancePaise,
        polledAt: new Date(),
      });
      const burn30dPaise = await this.compute30dBurn();
      this.evaluateAlert(balancePaise, burn30dPaise);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
      this.logger.warn(`MSG91 wallet poll failed (will retry next cycle): ${msg}`);
      await this.snapshotModel
        .create({
          provider: 'msg91',
          balancePaise: -1,
          polledAt: new Date(),
          errorMessage: msg.slice(0, 500),
        })
        .catch(() => {
          /* never cascade snapshot persistence failures */
        });
    }
  }

  /**
   * Wave 8.1 — pre-flight wallet check before debiting customer credit.
   * Reads the latest snapshot (single-doc lookup, fast) and returns
   * `true` if balance >= estCostPaise × safetyMultiplier.
   *
   * Fail-open semantics:
   *   - No snapshot yet (e.g. fresh deploy, MSG91 not configured) → true
   *   - estCostPaise <= 0 (cost-table miss) → true
   *
   * Stale-snapshot risk: poll runs hourly. Default safetyMultiplier=1.5
   * compensates for up-to-60min drain between polls. Override per call
   * for tight margins (bulk dispatch).
   */
  async hasRunwayFor(
    estCostPaise: number,
    safetyMultiplier: number = env.msg91.preflightSafetyMultiplier,
  ): Promise<boolean> {
    if (!estCostPaise || estCostPaise <= 0) return true;
    const latest = await this.snapshotModel
      .findOne({ provider: 'msg91' })
      .sort({ polledAt: -1 })
      .lean();
    if (!latest) {
      // No snapshot yet — fail-open, but log once so ops notice on fresh
      // deploys before MSG91 wallet has been configured.
      this.logger.debug('hasRunwayFor: no Msg91WalletSnapshot yet — failing open.');
      return true;
    }
    if (latest.balancePaise < 0) return true; // poll error → fail-open
    return latest.balancePaise >= estCostPaise * safetyMultiplier;
  }

  /**
   * Latest balance in paise, -1 if no successful poll yet. Used by
   * pack-purchase hook to compute "do we have runway for this pack".
   */
  async getLatestBalancePaise(): Promise<number> {
    const latest = await this.snapshotModel
      .findOne({ provider: 'msg91', balancePaise: { $gte: 0 } })
      .sort({ polledAt: -1 })
      .lean();
    return latest?.balancePaise ?? -1;
  }

  /**
   * Public read for the admin dashboard. Returns the latest snapshot +
   * 30d burn + projection.
   */
  async getStatus(): Promise<{
    balancePaise: number;
    polledAt: Date | null;
    burn30dPaise: number;
    avgDailyBurnPaise: number;
    projectedZeroDate: Date | null;
    alertLevel: 'ok' | 'warn' | 'alarm' | 'unknown';
  }> {
    const latest = await this.snapshotModel
      .findOne({ provider: 'msg91' })
      .sort({ polledAt: -1 })
      .lean();
    const burn30dPaise = await this.compute30dBurn();
    const avgDailyBurnPaise = Math.round(burn30dPaise / 30);

    let projectedZeroDate: Date | null = null;
    if (latest && latest.balancePaise > 0 && avgDailyBurnPaise > 0) {
      const daysLeft = Math.floor(latest.balancePaise / avgDailyBurnPaise);
      projectedZeroDate = new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000);
    }

    const alertLevel = !latest
      ? 'unknown'
      : this.classifyAlert(latest.balancePaise, avgDailyBurnPaise);

    return {
      balancePaise: latest?.balancePaise ?? -1,
      polledAt: latest?.polledAt ?? null,
      burn30dPaise,
      avgDailyBurnPaise,
      projectedZeroDate,
      alertLevel,
    };
  }

  private isEnabled(): boolean {
    const authKey = this.config.get<string>('app.msg91.authKey');
    if (!authKey) {
      this.logger.debug('MSG91 wallet poll skipped — MSG91_AUTH_KEY not configured.');
      return false;
    }
    return true;
  }

  /**
   * Hits MSG91 wallet balance endpoint. Endpoint shape varies across MSG91
   * API versions; this implementation targets the v5 wallet endpoint and
   * parses both common response shapes seen in MSG91 docs:
   *   { type: 'success', data: { balance: <rupees> } }
   *   { balance: <rupees> }
   * Returns paise.
   */
  private async fetchWalletBalance(): Promise<number> {
    const authKey = this.config.get<string>('app.msg91.authKey');
    if (!authKey) throw new Error('MSG91_AUTH_KEY missing');

    const res = await fetch(this.balanceEndpoint, {
      method: 'GET',
      headers: {
        authkey: authKey,
        'content-type': 'application/json',
      },
    });
    const text = await res.text();
    type Msg91WalletResponse = {
      data?: { balance?: number; amount?: number };
      balance?: number;
      raw?: string;
    };
    let parsed: Msg91WalletResponse;
    try {
      parsed = JSON.parse(text) as Msg91WalletResponse;
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`MSG91 wallet ${res.status}: ${text.slice(0, 200)}`);
    }
    const rupees = parsed.data?.balance ?? parsed.balance ?? parsed.data?.amount ?? null;
    if (rupees === null || rupees === undefined) {
      throw new Error(`Unexpected MSG91 wallet payload: ${text.slice(0, 200)}`);
    }
    return Math.round(Number(rupees) * 100);
  }

  private async compute30dBurn(): Promise<number> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await this.dispatchLogModel.aggregate<{
      totalPaise: number;
    }>([
      {
        $match: {
          provider: 'msg91',
          createdAt: { $gte: cutoff },
          status: 'sent',
          providerCostPaise: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          totalPaise: { $sum: '$providerCostPaise' },
        },
      },
    ]);
    return result[0]?.totalPaise ?? 0;
  }

  private classifyAlert(balancePaise: number, avgDailyBurnPaise: number): 'ok' | 'warn' | 'alarm' {
    if (avgDailyBurnPaise <= 0) return 'ok';
    if (balancePaise < avgDailyBurnPaise) return 'alarm';
    if (balancePaise < avgDailyBurnPaise * 5) return 'warn';
    return 'ok';
  }

  private evaluateAlert(balancePaise: number, burn30dPaise: number): void {
    const avgDailyBurnPaise = Math.round(burn30dPaise / 30);
    const level = this.classifyAlert(balancePaise, avgDailyBurnPaise);
    if (level === 'alarm') {
      this.logger.error(
        `[MSG91 ALARM] wallet=₹${balancePaise / 100} avgDailyBurn=₹${avgDailyBurnPaise / 100} — top up NOW.`,
      );
    } else if (level === 'warn') {
      this.logger.warn(
        `[MSG91 WARN] wallet=₹${balancePaise / 100} avgDailyBurn=₹${avgDailyBurnPaise / 100} — <5 days runway.`,
      );
    }
  }
}
