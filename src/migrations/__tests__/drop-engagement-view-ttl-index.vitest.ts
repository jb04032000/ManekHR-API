/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Migration 0043 (ADR-0002): drop the stale `engagement_view_ttl` partial TTL
 * index on `connectengagementedges`. `view` edges are now the PERMANENT dedup
 * marker behind the lifetime-unique `Post.viewCount`, so the 90-day auto-expiry
 * (which let a re-view re-increment the count) is removed from the schema and
 * dropped from existing DBs here. Links: drop-engagement-view-ttl-index.ts,
 * connect/feed/schemas/engagement-edge.schema.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  InjectModel: () => () => undefined,
  getModelToken: (name: string) => `${name}Model`,
  MongooseModule: { forFeature: () => ({}) },
}));

import { DropEngagementViewTtlIndexService } from '../drop-engagement-view-ttl-index';

function buildEdgeModel(indexes: any[]) {
  const collection = {
    indexes: vi.fn().mockResolvedValue(indexes),
    dropIndex: vi.fn().mockResolvedValue(undefined),
  };
  return { collection };
}

describe('DropEngagementViewTtlIndexService', () => {
  it('drops the engagement_view_ttl partial TTL index when present', async () => {
    const model = buildEdgeModel([
      { name: '_id_', key: { _id: 1 } },
      { name: 'actorId_1_postId_1_type_1', key: { actorId: 1, postId: 1, type: 1 }, unique: true },
      {
        name: 'engagement_view_ttl',
        key: { createdAt: 1 },
        expireAfterSeconds: 7776000,
        partialFilterExpression: { type: 'view' },
      },
    ]);
    const svc = new DropEngagementViewTtlIndexService(model as any);

    const result = await svc.run();

    expect(model.collection.dropIndex).toHaveBeenCalledWith('engagement_view_ttl');
    expect(result.viewTtlIndexDropped).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('is idempotent: no view TTL index -> no-op', async () => {
    const model = buildEdgeModel([
      { name: '_id_', key: { _id: 1 } },
      { name: 'actorId_1_postId_1_type_1', key: { actorId: 1, postId: 1, type: 1 }, unique: true },
    ]);
    const svc = new DropEngagementViewTtlIndexService(model as any);

    const result = await svc.run();

    expect(model.collection.dropIndex).not.toHaveBeenCalled();
    expect(result.viewTtlIndexDropped).toBe(false);
  });

  it('leaves an unrelated TTL index (not view-scoped) untouched', async () => {
    const model = buildEdgeModel([
      // A TTL index that is NOT the view-edge one (different partial filter).
      {
        name: 'some_other_ttl',
        key: { createdAt: 1 },
        expireAfterSeconds: 3600,
        partialFilterExpression: { type: 'share' },
      },
    ]);
    const svc = new DropEngagementViewTtlIndexService(model as any);

    const result = await svc.run();

    expect(model.collection.dropIndex).not.toHaveBeenCalled();
    expect(result.viewTtlIndexDropped).toBe(false);
  });
});
