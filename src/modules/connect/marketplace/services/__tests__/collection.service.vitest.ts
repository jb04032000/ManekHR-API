/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema imports don't trip vitest's reflect-metadata
// pipeline. Models + injected services are supplied as plain positional mocks.
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

import { Types } from 'mongoose';
import { CollectionService, MAX_COLLECTIONS } from '../collection.service';

/** A chainable mongoose query stub whose `exec()` resolves to `result`. */
function query(result: unknown) {
  const q: any = {};
  for (const m of ['find', 'findOne', 'findById', 'sort', 'select', 'lean']) {
    q[m] = vi.fn().mockReturnValue(q);
  }
  q.exec = vi.fn().mockResolvedValue(result);
  return q;
}

function makeDoc<T extends Record<string, unknown>>(fields: T) {
  return { ...fields, save: vi.fn().mockResolvedValue(undefined) };
}

const owner = new Types.ObjectId().toString();
const audit = { logEvent: vi.fn().mockResolvedValue(undefined) } as any;
const storefronts = { getMine: vi.fn().mockResolvedValue({ _id: 'sf' }) } as any;
// Stub media-ownership guard (trailing @Optional ctor arg) for the create/update
// paths; no-op here, the real guard is covered by the uploads module's tests.
const media = {
  assertOwnedMedia: () => Promise.resolve(),
  assertOwnedSingle: () => Promise.resolve(),
} as any;

beforeEach(() => {
  audit.logEvent.mockClear();
  storefronts.getMine.mockClear();
});

describe('CollectionService.create', () => {
  it('throws at the collection cap', async () => {
    const model: any = { countDocuments: vi.fn().mockResolvedValue(MAX_COLLECTIONS) };
    const svc = new CollectionService(model, {} as any, storefronts, audit, undefined, media);
    await expect(
      svc.create(owner, new Types.ObjectId().toString(), { title: 'Bridal' }),
    ).rejects.toThrow(/at most/);
  });

  it('creates with a derived slug and next sortIndex', async () => {
    let created: any;
    const model: any = {
      countDocuments: vi.fn().mockResolvedValue(2),
      exists: vi.fn().mockResolvedValue(null), // slug free
      findOne: vi.fn().mockReturnValue(query({ sortIndex: 4 })),
      create: vi.fn().mockImplementation((p: any) => {
        created = makeDoc({ _id: new Types.ObjectId(), ...p });
        return created;
      }),
    };
    const svc = new CollectionService(model, {} as any, storefronts, audit, undefined, media);
    const doc: any = await svc.create(owner, new Types.ObjectId().toString(), {
      title: 'Bridal Sarees',
    });
    expect(doc.slug).toBe('bridal-sarees');
    expect(doc.sortIndex).toBe(5); // 4 + 1
    expect(audit.logEvent).toHaveBeenCalledOnce();
  });
});

describe('CollectionService.setProducts', () => {
  it('adds new members, pulls removed ones, and sets the order', async () => {
    const colId = new Types.ObjectId();
    const sf = new Types.ObjectId();
    const keep = new Types.ObjectId(); // stays
    const add = new Types.ObjectId(); // newly included
    const drop = new Types.ObjectId(); // currently a member, now excluded

    const colDoc = makeDoc({
      _id: colId,
      ownerUserId: owner,
      storefrontId: sf,
      productOrder: [] as Types.ObjectId[],
    });

    const listingFind = vi
      .fn()
      // 1) filterOwnedShopListings -> valid (keep, add) in given order
      .mockReturnValueOnce(query([{ _id: keep }, { _id: add }]))
      // 2) current members -> (keep, drop)
      .mockReturnValueOnce(query([{ _id: keep }, { _id: drop }]));

    const listingModel: any = {
      find: listingFind,
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const model: any = { findById: vi.fn().mockResolvedValue(colDoc) };

    const svc = new CollectionService(model, listingModel, storefronts, audit);
    await svc.setProducts(colId.toString(), owner, [keep.toString(), add.toString()]);

    // One updateMany adds the collection id to `add`; another pulls it from `drop`.
    const calls = listingModel.updateMany.mock.calls;
    const addCall = calls.find((c: any) => JSON.stringify(c[1]).includes('$addToSet'));
    const pullCall = calls.find((c: any) => JSON.stringify(c[1]).includes('$pull'));
    expect(addCall[0]._id.$in.map(String)).toEqual([add.toString()]);
    expect(pullCall[0]._id.$in.map(String)).toEqual([drop.toString()]);
    // Order is the given valid order.
    expect(colDoc.productOrder.map(String)).toEqual([keep.toString(), add.toString()]);
    expect(colDoc.save).toHaveBeenCalledOnce();
  });
});

describe('CollectionService.setListingCollections', () => {
  it('sets the listing membership and maintains advisory order', async () => {
    const sf = new Types.ObjectId();
    const had = new Types.ObjectId(); // currently in, will be removed
    const want = new Types.ObjectId(); // newly added
    const listingId = new Types.ObjectId();

    const listingDoc = makeDoc({
      _id: listingId,
      ownerUserId: owner,
      storefrontId: sf,
      collectionIds: [had] as Types.ObjectId[],
    });
    const listingModel: any = { findById: vi.fn().mockResolvedValue(listingDoc) };
    // owned collections matching the requested set -> only `want`.
    const model: any = {
      find: vi.fn().mockReturnValue(query([{ _id: want }])),
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    const svc = new CollectionService(model, listingModel, storefronts, audit);
    const res = await svc.setListingCollections(listingId.toString(), owner, [want.toString()]);

    expect(res.collectionIds).toEqual([want.toString()]);
    expect(listingDoc.collectionIds.map(String)).toEqual([want.toString()]);
    // `want` gets the listing appended to its order; `had` gets it pulled.
    const calls = model.updateMany.mock.calls;
    expect(calls.some((c: any) => JSON.stringify(c[1]).includes('$addToSet'))).toBe(true);
    expect(calls.some((c: any) => JSON.stringify(c[1]).includes('$pull'))).toBe(true);
    expect(listingDoc.save).toHaveBeenCalledOnce();
  });

  it('rejects a listing the caller does not own', async () => {
    const listingModel: any = {
      findById: vi.fn().mockResolvedValue({ _id: 'x', ownerUserId: 'someone-else' }),
    };
    const svc = new CollectionService({} as any, listingModel, storefronts, audit);
    await expect(
      svc.setListingCollections(new Types.ObjectId().toString(), owner, []),
    ).rejects.toThrow(/not found/i);
  });
});
