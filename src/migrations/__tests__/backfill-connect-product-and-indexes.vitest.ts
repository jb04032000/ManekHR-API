/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema imports do not trip vitest's reflect-metadata
// pipeline. Models + their `.collection` are injected as plain mocks.
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { BackfillConnectProductAndIndexesService } from '../backfill-connect-product-and-indexes';

/**
 * M0.8 - back-fill product:'erp' + drop the legacy single-product subscription
 * unique indexes (risk #1).
 *
 *   - product backfill runs updateMany({ product: { $exists: false } }) on
 *     Plan / Subscription / Tier so product-scoped queries match legacy docs,
 *   - the new product-scoped indexes are ensured BEFORE the legacy ones drop,
 *   - the legacy `userId_1` + `userId_1_status_1` unique indexes drop when
 *     present (guarded), the workspace index is left intact,
 *   - re-running with the legacy indexes already gone is a no-op,
 *   - a non-unique userId_1 (some unrelated lookup index) is never dropped.
 */
const PRODUCT_FILTER = { product: { $exists: false } };
const PRODUCT_UPDATE = { $set: { product: 'erp' } };

const build = (indexes: Array<{ name: string; unique?: boolean }> = []) => {
  const collection = {
    createIndex: vi.fn().mockResolvedValue('ok'),
    indexes: vi.fn().mockResolvedValue(indexes),
    dropIndex: vi.fn().mockResolvedValue('ok'),
  };
  const subModel = {
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 2 }),
    collection,
  };
  const planModel = { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 3 }) };
  const tierModel = { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }) };
  const svc = new BackfillConnectProductAndIndexesService(
    subModel as any,
    planModel as any,
    tierModel as any,
  );
  return { svc, subModel, planModel, tierModel, collection };
};

describe('BackfillConnectProductAndIndexesService (M0.8)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('backfills product:erp on plan, subscription, and tier docs lacking it', async () => {
    const { svc, subModel, planModel, tierModel } = build();
    await svc.run();
    expect(planModel.updateMany).toHaveBeenCalledWith(PRODUCT_FILTER, PRODUCT_UPDATE);
    expect(subModel.updateMany).toHaveBeenCalledWith(PRODUCT_FILTER, PRODUCT_UPDATE);
    expect(tierModel.updateMany).toHaveBeenCalledWith(PRODUCT_FILTER, PRODUCT_UPDATE);
  });

  it('ensures the new product-scoped indexes then drops the legacy unique indexes', async () => {
    const { svc, collection } = build([
      { name: 'userId_1', unique: true },
      { name: 'userId_1_status_1', unique: true },
      { name: 'userId_1_product_1', unique: true },
      { name: 'userId_1_workspaceId_1', unique: true },
    ]);
    const result = await svc.run();
    expect(collection.createIndex).toHaveBeenCalledTimes(2); // active + scheduled ensured first
    expect(collection.dropIndex).toHaveBeenCalledWith('userId_1');
    expect(collection.dropIndex).toHaveBeenCalledWith('userId_1_status_1');
    expect(collection.dropIndex).not.toHaveBeenCalledWith('userId_1_workspaceId_1');
    expect(result.droppedIndexes).toEqual(['userId_1', 'userId_1_status_1']);
  });

  it('is idempotent: drops nothing when the legacy indexes are already gone', async () => {
    const { svc, collection } = build([
      { name: 'userId_1_product_1', unique: true },
      { name: 'userId_1_product_1_status_1', unique: true },
      { name: 'userId_1_workspaceId_1', unique: true },
    ]);
    const result = await svc.run();
    expect(collection.dropIndex).not.toHaveBeenCalled();
    expect(result.droppedIndexes).toEqual([]);
  });

  it('never drops a non-unique userId_1 index (safety guard)', async () => {
    const { svc, collection } = build([{ name: 'userId_1', unique: false }]);
    await svc.run();
    expect(collection.dropIndex).not.toHaveBeenCalled();
  });
});
