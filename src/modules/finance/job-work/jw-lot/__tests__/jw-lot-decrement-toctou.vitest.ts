/**
 * Phase 15-04 — TOCTOU regression test for JwLotService.decrementQty
 *
 * Guards against regression of F-11 CR-02 fix (atomic findOneAndUpdate
 * aggregation pipeline replacing the prior read-then-write TOCTOU race).
 *
 * Scenario: seed a JwLot with qtyRemaining = 10. Fire 10 parallel
 * decrementQty calls each requesting totalDec = 2 (split across qtyGood
 * and qtyWastage). Total requested = 20 > 10 available.
 *
 * Expectations under the post-CR-02-fix implementation:
 *  - Exactly 5 calls succeed (10 / 2 = 5)
 *  - Exactly 5 calls reject with ConflictException
 *  - Final qtyRemaining === 0 (no overspend, no underspend)
 *  - qtyReturnedGood + qtyWasted === 10
 *  - status === 'closed' (since post-decrement remaining hits 0)
 *
 * If a future change reintroduces a non-atomic read-then-write pattern,
 * concurrent calls will overspend and this test will fail loudly.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from 'vitest';

// JwLotService imports `dayjs` for unrelated lot-number generation.
// `dayjs` is not currently in the backend node_modules tree (pre-existing
// dependency gap, out of scope for this regression test). decrementQty
// itself does not use dayjs, so stub the module to allow JwLotService
// to load under Vitest without resolving the missing package.
vi.mock('dayjs', () => {
  const fn = (_d?: any) => ({
    format: () => '20260430',
    add: () => ({ toDate: () => new Date('2027-04-30') }),
    toDate: () => new Date('2026-04-30'),
  });
  return { default: fn, __esModule: true };
});

import mongoose, { Types } from 'mongoose';
import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  TestMongo,
} from '../../../../../test-utils/mongo-memory';

import { JobWorkLot, JobWorkLotSchema } from '../jw-lot.schema';
import { JwLotService } from '../jw-lot.service';

describe('JwLotService.decrementQty — TOCTOU regression (Phase 15-04)', () => {
  let mongo: TestMongo;
  let lotModel: mongoose.Model<any>;
  let service: JwLotService;

  beforeAll(async () => {
    mongo = await createTestMongoose();

    function getOrDefine<T>(
      name: string,
      schema: mongoose.Schema,
    ): mongoose.Model<T> {
      try {
        return mongoose.model<T>(name);
      } catch {
        return mongoose.model<T>(name, schema);
      }
    }

    lotModel = getOrDefine(JobWorkLot.name, JobWorkLotSchema);
    await lotModel.syncIndexes();

    service = new JwLotService(lotModel as any);
  });

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);
    await lotModel.syncIndexes();
  });

  /**
   * Seed a JwLot with qtyRemaining=10 in a 'pending' state, leaving room
   * for 5 successful decrementQty calls of totalDec=2 each.
   */
  async function seedLotQty10(): Promise<Types.ObjectId> {
    const wsId = new Types.ObjectId();
    const firmId = new Types.ObjectId();
    const lot = await lotModel.create({
      workspaceId: wsId,
      firmId,
      principalPartyId: new Types.ObjectId(),
      inwardChallanId: new Types.ObjectId(),
      challanLineIndex: 0,
      lotNo: 'JWL-20260430-001',
      itemDescription: 'Test material',
      hsnCode: '5208',
      unit: 'KG',
      qtyInward: 10,
      qtyReturnedGood: 0,
      qtyWasted: 0,
      qtyRemaining: 10,
      godownId: new Types.ObjectId(),
      inwardDate: new Date('2026-04-01'),
      dueReturnDate: new Date('2027-04-01'),
      status: 'pending',
      isDeleted: false,
    });
    return lot._id as Types.ObjectId;
  }

  it('TOCTOU: concurrent decrementQty does not overspend', async () => {
    const lotId = await seedLotQty10();

    // 10 parallel calls — each requesting totalDec = 2.
    // Mix qtyGood and qtyWastage to exercise both pipeline branches.
    // Total requested = 20; only 10 available → exactly 5 should succeed.
    const calls = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? { qtyGood: 2, qtyWastage: 0 }
        : { qtyGood: 0, qtyWastage: 2 },
    );

    // Use Promise.allSettled so we can inspect every outcome without
    // short-circuiting on the first rejection.
    const results = await Promise.allSettled(
      calls.map((c) =>
        service.decrementQty({
          lotId,
          qtyGood: c.qtyGood,
          qtyWastage: c.qtyWastage,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Assertion 1: exactly 5 successes.
    expect(fulfilled.length).toBe(5);

    // Assertion 2: exactly 5 rejections.
    expect(rejected.length).toBe(5);

    // Assertion 2b: rejections must be ConflictException-shaped — message
    // produced by the service when findOneAndUpdate returns null.
    for (const r of rejected as PromiseRejectedResult[]) {
      const msg = String(r.reason?.message ?? r.reason);
      expect(msg).toMatch(/qty insufficient or already closed/i);
    }

    // Re-fetch the lot from the DB to verify persisted final state.
    const finalLot = await lotModel.findById(lotId).lean();
    expect(finalLot).not.toBeNull();

    // Assertion 3: no overspend, no underspend leak.
    expect(finalLot!.qtyRemaining).toBe(0);

    // Assertion 4: qtyReturnedGood + qtyWasted === 10
    // (sum of all 5 successful decrements at totalDec=2 each).
    expect(finalLot!.qtyReturnedGood + finalLot!.qtyWasted).toBe(10);

    // Assertion 5: status reflects qtyRemaining === 0 → 'closed'.
    expect(finalLot!.status).toBe('closed');
  });
});
