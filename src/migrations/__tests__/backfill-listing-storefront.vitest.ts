/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { describe, it, expect, vi } from 'vitest';

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

import { BackfillListingStorefrontService } from '../backfill-listing-storefront';

function build(owners: string[]) {
  const listingModel = {
    distinct: vi.fn(async () => owners),
    countDocuments: vi.fn(async () => 3),
    updateMany: vi.fn(async () => ({ modifiedCount: 3 })),
  };
  const storefronts = {
    getOrCreateDefaultStorefront: vi.fn(async (id: string) => ({ _id: `sf-for-${id}` })),
  };
  const svc = new BackfillListingStorefrontService(listingModel as any, storefronts as any);
  return { svc, listingModel, storefronts };
}

describe('BackfillListingStorefrontService', () => {
  it('backfills each owner: default storefront + updateMany on null storefrontId', async () => {
    const { svc, listingModel, storefronts } = build(['o1', 'o2']);
    const res = await svc.run();

    expect(listingModel.distinct).toHaveBeenCalledWith('ownerUserId', { storefrontId: null });
    expect(storefronts.getOrCreateDefaultStorefront).toHaveBeenCalledTimes(2);
    expect(listingModel.updateMany).toHaveBeenCalledWith(
      { ownerUserId: 'o1', storefrontId: null },
      { $set: { storefrontId: 'sf-for-o1' } },
    );
    expect(res.ownersProcessed).toBe(2);
    expect(res.listingsUpdated).toBe(6);
    expect(res.errors).toEqual([]);
  });

  it('is a no-op when no listing is missing a storefront (idempotent re-run)', async () => {
    const { svc, listingModel, storefronts } = build([]);
    const res = await svc.run();
    expect(storefronts.getOrCreateDefaultStorefront).not.toHaveBeenCalled();
    expect(listingModel.updateMany).not.toHaveBeenCalled();
    expect(res).toEqual({ ownersProcessed: 0, listingsUpdated: 0, errors: [] });
  });

  it('dry-run counts without writing', async () => {
    const { svc, listingModel } = build(['o1']);
    const res = await svc.run(true);
    expect(listingModel.updateMany).not.toHaveBeenCalled();
    expect(listingModel.countDocuments).toHaveBeenCalled();
    expect(res.listingsUpdated).toBe(3);
  });
});
