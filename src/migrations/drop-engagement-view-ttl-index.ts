import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EngagementEdge } from '../modules/connect/feed/schemas/engagement-edge.schema';

interface MigrationResult {
  viewTtlIndexDropped: boolean;
  errors: string[];
}

/**
 * Migration 0043 (ADR-0002) — drop the stale `view`-edge TTL index.
 *
 * BEFORE: `connectengagementedges` carried a partial TTL index
 * `engagement_view_ttl` ({ createdAt: 1 }, expireAfterSeconds: 90d,
 * partialFilterExpression: { type: 'view' }) that auto-expired `view` edges.
 * Because a `view` edge is the dedup marker behind `Post.viewCount`, expiry let
 * the same viewer re-view an old post and re-increment the count (upward drift).
 *
 * AFTER: `view` edges are PERMANENT (the schema no longer declares the TTL).
 * `Post.viewCount` is a true lifetime-unique tally; storage is bounded by
 * content lifecycle (FeedService.deletePost cascades a deleted post's view
 * edges + seen rows). The only reader, FeedService.getAffinityMap, already
 * filters `createdAt >= now − 60d`, so no read widens.
 *
 * THIS UNIT (run once, idempotent): drops `engagement_view_ttl` if it still
 * exists. Mongoose will not drop an index it no longer declares, so existing DBs
 * need this explicit drop. Detected by name OR by shape (a TTL index whose
 * partial filter targets `type: 'view'`), so a renamed index is still caught and
 * an unrelated TTL index is left alone. Re-running finds nothing to drop → no-op.
 *
 * Dependency note: writes only the `connectengagementedges` collection. Run via
 * `npm run migrate` (ADR-0001 ledgered runner), unit
 * `0043_connect_drop_engagement_view_ttl_index`.
 */
@Injectable()
export class DropEngagementViewTtlIndexService {
  private readonly logger = new Logger(DropEngagementViewTtlIndexService.name);
  private static readonly INDEX_NAME = 'engagement_view_ttl';

  constructor(
    @InjectModel(EngagementEdge.name) private readonly edgeModel: Model<EngagementEdge>,
  ) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { viewTtlIndexDropped: false, errors: [] };

    try {
      const collection = this.edgeModel.collection;
      const indexes = (await collection.indexes()) as Array<{
        name?: string;
        expireAfterSeconds?: number;
        partialFilterExpression?: Record<string, unknown>;
      }>;
      // Match the legacy index by name, or by shape (TTL + view-only partial
      // filter) so a custom-named equivalent is still caught — but never a TTL
      // index scoped to a different engagement type.
      const stale = indexes.find(
        (ix) =>
          ix.name === DropEngagementViewTtlIndexService.INDEX_NAME ||
          (typeof ix.expireAfterSeconds === 'number' &&
            ix.partialFilterExpression?.type === 'view'),
      );
      if (stale?.name) {
        await collection.dropIndex(stale.name);
        result.viewTtlIndexDropped = true;
        this.logger.log(`Dropped stale view-edge TTL index "${stale.name}".`);
      } else {
        this.logger.log('No view-edge TTL index found (already migrated).');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to drop view-edge TTL index: ${detail}`);
      result.errors.push(`dropIndex: ${detail}`);
    }

    return result;
  }
}
