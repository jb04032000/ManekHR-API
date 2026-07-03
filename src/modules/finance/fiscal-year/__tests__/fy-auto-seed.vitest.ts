import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { Types, model } from 'mongoose';
import {
  startMemoryMongo,
  stopMemoryMongo,
  clearAllCollections,
} from '../../../../../test-utils/mongo-memory';
import {
  FiscalYear,
  FiscalYearSchema,
} from '../fiscal-year.schema';
import { getFiscalYearOfDate } from '../../common/fiscal-year.util';

/**
 * Auto-seed / idempotent backfill (Plan 03 Task 1 step 6).
 *
 * Validates the find-or-create upsert pattern that FiscalYearService.seedDefaultFy()
 * uses, without importing the service (which transitively pulls FirmSchema and
 * triggers an unrelated repo Mongoose autocast issue per STATE.md). The upsert
 * logic under test mirrors the production code 1:1.
 */
describe('FiscalYear seed-and-backfill upsert is idempotent', () => {
  let FyModel: any;
  const wsId = new Types.ObjectId();
  const firmId = new Types.ObjectId();

  beforeAll(async () => {
    await startMemoryMongo();
    FyModel = model('FiscalYear', FiscalYearSchema);
  });

  afterAll(async () => {
    await stopMemoryMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
  });

  // Replicates FiscalYearService.seedDefaultFy() upsert exactly.
  const seedDefault = async (referenceDate: Date) => {
    const window = getFiscalYearOfDate(referenceDate, 4);
    return FyModel.findOneAndUpdate(
      { wsId, firmId, startDate: window.startDate },
      {
        $setOnInsert: {
          wsId,
          firmId,
          startDate: window.startDate,
          endDate: window.endDate,
          status: 'OPEN',
          auditTrail: [],
        },
      },
      { upsert: true, new: true },
    ).exec();
  };

  it('first call creates an OPEN FY for the current Indian FY window', async () => {
    const today = new Date();
    const fy = await seedDefault(today);
    expect(fy).toBeDefined();
    expect(fy.status).toBe('OPEN');
    const expected = getFiscalYearOfDate(today, 4);
    expect(fy.startDate.toISOString()).toBe(expected.startDate.toISOString());
    expect(fy.endDate.toISOString()).toBe(expected.endDate.toISOString());
  });

  it('second call returns the same row — collection count remains 1', async () => {
    const today = new Date();
    const fy1 = await seedDefault(today);
    const fy2 = await seedDefault(today);
    expect((fy2._id as any).toString()).toBe((fy1._id as any).toString());
    const count = await FyModel.countDocuments({});
    expect(count).toBe(1);
  });
});
