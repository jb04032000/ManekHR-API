/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive schema import (FieldPredictionMemory extends Document) doesn't
// trip the "Cannot determine type" reflection error under vitest's esbuild
// transform. The Model is injected as a plain mock — Mongoose is never used.
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
import { SmartDefaultsService, RememberEntry } from '../smart-defaults.service';

/**
 * Unit coverage for SmartDefaultsService:
 *   - rememberMany builds the right tenant-scoped upsert ops + skips empty.
 *   - rememberMany swallows model errors (best-effort; never throws).
 *   - getForParty maps party fields + party_item rates into the tidy shape.
 *   - getForParty filters every query by workspaceId + firmId (tenant scope).
 */
describe('SmartDefaultsService', () => {
  let model: {
    bulkWrite: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };
  let svc: SmartDefaultsService;

  const wsId = new Types.ObjectId();
  const firmId = new Types.ObjectId();
  const partyId = new Types.ObjectId();

  // Chainable find() stub: .find().lean().maxTimeMS() resolves to `rows`.
  const mockFind = (rows: any[]) => {
    const chain: any = {
      lean: () => chain,
      maxTimeMS: () => Promise.resolve(rows),
    };
    return chain;
  };

  beforeEach(() => {
    model = {
      bulkWrite: vi.fn().mockResolvedValue({ ok: 1 }),
      find: vi.fn(),
    };
    svc = new SmartDefaultsService(model as any);
  });

  describe('rememberMany', () => {
    it('is a no-op for an empty entries array (no bulkWrite call)', async () => {
      await svc.rememberMany(wsId, firmId, []);
      expect(model.bulkWrite).not.toHaveBeenCalled();
    });

    it('upserts one tenant-scoped op per entry with the right key + value slot', async () => {
      const entries: RememberEntry[] = [
        { scope: 'party', key: partyId.toString(), field: 'dueDays', valueNum: 30 },
        {
          scope: 'party',
          key: partyId.toString(),
          field: 'placeOfSupplyStateCode',
          valueStr: '24',
        },
        {
          scope: 'party_item',
          key: `${partyId.toString()}:item1`,
          field: 'ratePaise',
          valueNum: 15000,
        },
      ];

      await svc.rememberMany(wsId, firmId, entries);

      expect(model.bulkWrite).toHaveBeenCalledTimes(1);
      const [ops, opts] = model.bulkWrite.mock.calls[0];
      expect(opts).toMatchObject({ ordered: false });
      expect(ops).toHaveLength(3);

      // dueDays → numeric slot, tenant-scoped filter, upsert true.
      const due = ops[0].updateOne;
      expect(due.upsert).toBe(true);
      expect(due.filter.workspaceId.toString()).toBe(wsId.toString());
      expect(due.filter.firmId.toString()).toBe(firmId.toString());
      expect(due.filter).toMatchObject({
        scope: 'party',
        key: partyId.toString(),
        field: 'dueDays',
      });
      expect(due.update.$set.valueNum).toBe(30);
      expect(due.update.$set.valueStr).toBeUndefined();
      expect(due.update.$set.updatedAt).toBeInstanceOf(Date);

      // placeOfSupplyStateCode → string slot only.
      const pos = ops[1].updateOne;
      expect(pos.update.$set.valueStr).toBe('24');
      expect(pos.update.$set.valueNum).toBeUndefined();

      // party_item ratePaise → numeric slot, compound key preserved.
      const rate = ops[2].updateOne;
      expect(rate.filter).toMatchObject({
        scope: 'party_item',
        key: `${partyId.toString()}:item1`,
        field: 'ratePaise',
      });
      expect(rate.update.$set.valueNum).toBe(15000);
    });

    it('NEVER throws when bulkWrite rejects (best-effort write)', async () => {
      model.bulkWrite.mockRejectedValueOnce(new Error('mongo down'));
      await expect(
        svc.rememberMany(wsId, firmId, [
          { scope: 'party', key: partyId.toString(), field: 'dueDays', valueNum: 7 },
        ]),
      ).resolves.toBeUndefined();
      expect(model.bulkWrite).toHaveBeenCalledTimes(1);
    });
  });

  describe('getForParty', () => {
    it('returns party fields + an itemRates map from the stored rows', async () => {
      const pk = partyId.toString();
      model.find.mockReturnValue(
        mockFind([
          { scope: 'party', key: pk, field: 'dueDays', valueNum: 45 },
          {
            scope: 'party',
            key: pk,
            field: 'placeOfSupplyStateCode',
            valueStr: '27',
          },
          {
            scope: 'party_item',
            key: `${pk}:itemA`,
            field: 'ratePaise',
            valueNum: 9900,
          },
          {
            scope: 'party_item',
            key: `${pk}:itemB`,
            field: 'ratePaise',
            valueNum: 12500,
          },
        ]),
      );

      const result = await svc.getForParty(wsId, firmId, partyId);

      expect(result.dueDays).toBe(45);
      expect(result.placeOfSupplyStateCode).toBe('27');
      expect(result.itemRates).toEqual({ itemA: 9900, itemB: 12500 });
    });

    it('returns an empty shape (just itemRates: {}) when no rows match', async () => {
      model.find.mockReturnValue(mockFind([]));
      const result = await svc.getForParty(wsId, firmId, partyId);
      expect(result).toEqual({ itemRates: {} });
    });

    it('filters the query by workspaceId + firmId (tenant scope)', async () => {
      model.find.mockReturnValue(mockFind([]));
      await svc.getForParty(wsId, firmId, partyId);

      expect(model.find).toHaveBeenCalledTimes(1);
      const filter = model.find.mock.calls[0][0];
      expect(filter.workspaceId.toString()).toBe(wsId.toString());
      expect(filter.firmId.toString()).toBe(firmId.toString());
      // $or scopes the read to this party's party + party_item rows.
      expect(Array.isArray(filter.$or)).toBe(true);
      expect(filter.$or[0]).toMatchObject({
        scope: 'party',
        key: partyId.toString(),
      });
      expect(filter.$or[1].scope).toBe('party_item');
      expect(filter.$or[1].key).toBeInstanceOf(RegExp);
    });
  });
});
