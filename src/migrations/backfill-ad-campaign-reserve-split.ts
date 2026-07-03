import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

interface MigrationResult {
  campaignsScanned: number;
  campaignsBackfilled: number;
  errors: string[];
}

/**
 * Migration 0054 (Connect feed harden, CN-ADS-1) — backfill the new
 * `reservedFromGrant` / `reservedFromBalance` reserve-split fields on
 * IN-FLIGHT `ad_campaigns`.
 *
 * BACKGROUND: `WalletService.reserve()` computes a grant-first split every call
 * but never persisted it per-campaign, so `WalletService.release()` always
 * credited 100% back to purchased `balance` — silently converting a campaign's
 * expiring grant credits into permanent balance on pause/cancel/stop. The fix
 * (see ad-campaign.schema.ts + wallet.service.ts) tracks the split on the
 * campaign so release() restores each credit to its ORIGIN bucket.
 *
 * THIS UNIT (run once, idempotent): for every campaign with a LIVE reserve
 * (status in {active, paused, pending_review}) that has NOT yet been stamped
 * (`reservedFromGrant`/`reservedFromBalance` both absent), set:
 *   reservedFromGrant   = 0
 *   reservedFromBalance = max(0, totalBudget - budgetSpent)
 * This grant-blind default is the SAFE assumption for pre-existing data:
 * "assume the whole reserve was purchased," so a backfilled campaign's release
 * behaves EXACTLY as it does today (all to balance). Only campaigns reserved
 * AFTER the fix ships carry the true grant/purchased split. Terminal campaigns
 * (completed/rejected) hold no reserve, so they are skipped entirely.
 *
 * Idempotent: the filter requires BOTH split fields absent, so a re-run finds
 * already-stamped rows and modifies 0. Real values written after the code fix
 * are never clobbered (they already have the fields → excluded by the filter).
 *
 * Raw-connection unit (no model wiring), mirrors BackfillConnectContentIsDemo.
 * Dependency note: reads + writes `ad_campaigns`. Run via `npm run migrate`
 * (ADR-0001 ledgered runner), unit `0054_connect_backfill_ad_campaign_reserve_split`.
 */
@Injectable()
export class BackfillAdCampaignReserveSplitService {
  private readonly logger = new Logger(BackfillAdCampaignReserveSplitService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private col(name: string) {
    const db = this.connection.db;
    if (!db) throw new Error('Mongo connection not ready');
    return db.collection(name);
  }

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      campaignsScanned: 0,
      campaignsBackfilled: 0,
      errors: [],
    };

    try {
      const campaigns = this.col('ad_campaigns');
      // Only in-flight campaigns hold a reserve; only un-stamped rows need work.
      const filter = {
        status: { $in: ['active', 'paused', 'pending_review'] },
        reservedFromGrant: { $exists: false },
        reservedFromBalance: { $exists: false },
      };
      const cursor = campaigns.find(filter, {
        projection: { totalBudget: 1, budgetSpent: 1 },
      });
      const rows = await cursor.toArray();
      result.campaignsScanned = rows.length;

      for (const c of rows) {
        const totalBudget = (c.totalBudget as number) ?? 0;
        const budgetSpent = (c.budgetSpent as number) ?? 0;
        const reservedFromBalance = Math.max(0, totalBudget - budgetSpent);
        const upd = await campaigns.updateOne(
          {
            _id: c._id,
            // Re-assert the un-stamped guard so a concurrent write cannot be clobbered.
            reservedFromGrant: { $exists: false },
            reservedFromBalance: { $exists: false },
          },
          { $set: { reservedFromGrant: 0, reservedFromBalance } },
        );
        result.campaignsBackfilled += upd.modifiedCount ?? 0;
      }

      this.logger.log(
        `Backfilled ad-campaign reserve split: ${result.campaignsBackfilled} of ` +
          `${result.campaignsScanned} in-flight campaign(s) stamped ` +
          `(reservedFromGrant=0, reservedFromBalance=unspent).`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to backfill ad-campaign reserve split: ${detail}`);
      result.errors.push(`backfill: ${detail}`);
    }

    return result;
  }
}
