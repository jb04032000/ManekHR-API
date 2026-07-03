import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Session } from '../modules/sessions/schemas/session.schema';

interface MigrationResult {
  oldExpiresAtTtlIndexDropped: boolean;
  rowsStampedRetainUntil: number;
  errors: string[];
}

/**
 * Migration 0040 (auth-hardening OQ-4) — decouple session-row retention from
 * JWT lifetime.
 *
 * BEFORE: the `sessions` collection had a TTL index `{ expiresAt: 1 }` with
 * `expireAfterSeconds: 0`, so every session row was hard-deleted ~7 days after
 * login (the JWT lifetime). That destroyed the device/IP/userAgent login-audit
 * trail well inside the DPDP 1-year traffic-log window.
 *
 * AFTER: the schema's TTL index moves to `{ retainUntil: 1 }` (sparse,
 * expireAfterSeconds:0). The hourly session-cleanup cron clears the dead
 * `jwtTokenHash` (Bucket C) and stamps `retainUntil = clearedAt + 1 year`
 * (Bucket D) on cleared rows; only those rows then auto-delete, a year later.
 *
 * THIS UNIT (run once, idempotent):
 *   1. Drops the stale `expiresAt` TTL index if it still exists, so Mongo stops
 *      auto-deleting rows on the 7-day clock. (Mongoose creates the new
 *      `retainUntil` index from the schema on connect; we only need to remove
 *      the OLD one — Mongoose will not drop an index it no longer declares.)
 *   2. Stamps `retainUntil = now + 1 year` on every already-cleared row
 *      (isActive:false OR expiresAt in the past) that has no `retainUntil` yet,
 *      so existing expired rows enter the audit-retention window instead of
 *      being orphaned without a deletion clock. This step MIRRORS the hourly
 *      cron's update shape (SessionsService.applySessionRetention): alongside
 *      `retainUntil` it also sets `isActive: false` and clears the dead Bucket-C
 *      `jwtTokenHash` to `''`. (AUTH-H2) WHY clear the hash here: the cron only
 *      touches rows where `retainUntil` is null, so once this backfill stamps
 *      `retainUntil`, the cron will never revisit these rows — if we did NOT
 *      clear the hash now, these backfilled rows would keep their (Bucket C)
 *      token hash for the full year, contradicting the data map. Empty string
 *      (not unset) keeps the schema's `required` constraint satisfied while
 *      removing the live hash, exactly as the cron does.
 *
 * Idempotency: re-running finds no `expiresAt` TTL index to drop and no
 * unstamped cleared rows, so it is a safe no-op.
 *
 * Reversibility (forward-only ledger): to roll back, re-create the
 * `{ expiresAt: 1 }` TTL index with expireAfterSeconds:0 and drop the
 * `retainUntil` index — but that would re-enable 7-day deletion of the audit
 * trail, so rollback is not recommended.
 *
 * Dependency note: writes only the `sessions` collection. Run via `npm run
 * migrate` (ADR-0001 ledgered runner), unit `0040_sessions_audit_retention`.
 */
@Injectable()
export class MigrateSessionAuditRetentionService {
  private readonly logger = new Logger(MigrateSessionAuditRetentionService.name);

  /** 1-year audit-retention window (matches SessionsService.SESSION_AUDIT_RETENTION_MS). */
  private readonly RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

  constructor(@InjectModel(Session.name) private readonly sessionModel: Model<Session>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      oldExpiresAtTtlIndexDropped: false,
      rowsStampedRetainUntil: 0,
      errors: [],
    };

    // 1. Drop the stale `expiresAt` TTL index if present. The index name Mongo
    //    assigns to `{ expiresAt: 1 }` is `expiresAt_1`. We look it up by key
    //    pattern (robust to a custom name) and only drop one that is actually a
    //    TTL index (carries `expireAfterSeconds`), so a non-TTL `expiresAt`
    //    index (none today) would be left alone.
    try {
      const collection = this.sessionModel.collection;
      const indexes = (await collection.indexes()) as Array<{
        name?: string;
        key?: Record<string, number>;
        expireAfterSeconds?: number;
      }>;
      const stale = indexes.find(
        (ix) =>
          ix.key &&
          Object.keys(ix.key).length === 1 &&
          ix.key.expiresAt === 1 &&
          typeof ix.expireAfterSeconds === 'number',
      );
      if (stale?.name) {
        await collection.dropIndex(stale.name);
        result.oldExpiresAtTtlIndexDropped = true;
        this.logger.log(`Dropped stale session TTL index "${stale.name}" (expiresAt-based).`);
      } else {
        this.logger.log('No stale expiresAt TTL index found (already migrated).');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to drop stale expiresAt TTL index: ${detail}`);
      result.errors.push(`dropIndex: ${detail}`);
    }

    // 2. Stamp retainUntil on already-cleared rows missing it, so they enter
    //    the 1-year window rather than living forever (now that the 7-day TTL
    //    is gone) or being orphaned without a deletion clock. Mirror the cron's
    //    update shape exactly: also flip isActive:false and clear the dead
    //    Bucket-C jwtTokenHash to '' — otherwise the cron (which only revisits
    //    rows with a null retainUntil) would never clear the hash, leaving it
    //    for the full retention year (AUTH-H2).
    try {
      const now = new Date();
      const retainUntil = new Date(now.getTime() + this.RETENTION_MS);
      const update = await this.sessionModel.updateMany(
        {
          $or: [{ isActive: false }, { expiresAt: { $lt: now } }],
          retainUntil: { $in: [null, undefined] },
        },
        {
          $set: {
            isActive: false,
            // Bucket C: the token hash is dead once the session is cleared.
            // Empty string (not unset) satisfies the schema `required` rule.
            jwtTokenHash: '',
            retainUntil,
          },
        },
      );
      result.rowsStampedRetainUntil = update.modifiedCount ?? 0;
      this.logger.log(
        `Stamped retainUntil on ${result.rowsStampedRetainUntil} already-cleared session rows.`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to stamp retainUntil on cleared rows: ${detail}`);
      result.errors.push(`stampRetainUntil: ${detail}`);
    }

    return result;
  }
}
