import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { FinanceDataVersion } from './finance-data-version.schema';

/**
 * D17 report result cache. Correct-by-construction: results are keyed by the firm's data version,
 * which bumps on every posting, so a cached value can never be stale (its key stops matching). A
 * miss recomputes from the live aggregation (the source of truth) and re-caches. In-memory + per
 * instance; the shared version (in Mongo) coordinates invalidation across instances. Cross-link:
 * LedgerEntry post-save hook (calls bumpVersion); consumers wrap their compute in getOrCompute.
 */
@Injectable()
export class ReportCacheService {
  // key `${ws}:${firm}:${reportKey}` -> { version, value }. One entry per (firm, report); a newer
  // version overwrites the old one, so the map is bounded by distinct (firm, report) pairs.
  private readonly cache = new Map<string, { version: number; value: unknown }>();

  constructor(
    @InjectModel(FinanceDataVersion.name)
    private readonly versionModel: Model<FinanceDataVersion>,
  ) {}

  /** Bump a firm's data version (called from the posting hook). Fail-safe at the call site. */
  async bumpVersion(
    workspaceId: Types.ObjectId | string,
    firmId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<void> {
    await this.versionModel.updateOne(
      { workspaceId: new Types.ObjectId(workspaceId), firmId: new Types.ObjectId(firmId) },
      { $inc: { version: 1 } },
      { upsert: true, ...(session ? { session } : {}) },
    );
  }

  async getVersion(
    workspaceId: Types.ObjectId | string,
    firmId: Types.ObjectId | string,
  ): Promise<number> {
    const doc = await this.versionModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId), firmId: new Types.ObjectId(firmId) })
      .lean();
    return doc?.version ?? 0;
  }

  /**
   * Return a cached report value if it matches the firm's current version, else run `compute`
   * (the live aggregation), cache it against the current version, and return it. Never returns a
   * value computed against an older version, so it can't be stale.
   */
  async getOrCompute<T>(
    workspaceId: Types.ObjectId | string,
    firmId: Types.ObjectId | string,
    reportKey: string,
    compute: () => Promise<T>,
  ): Promise<T> {
    const version = await this.getVersion(workspaceId, firmId);
    const key = `${String(workspaceId)}:${String(firmId)}:${reportKey}`;
    const hit = this.cache.get(key);
    if (hit && hit.version === version) return hit.value as T;
    const value = await compute();
    this.cache.set(key, { version, value });
    return value;
  }
}
