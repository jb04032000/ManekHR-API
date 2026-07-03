import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { model } from 'mongoose';
import {
  startMemoryMongo,
  stopMemoryMongo,
  clearAllCollections,
} from '../../../../../test-utils/mongo-memory';
import { FiscalYearSchema } from '../fiscal-year.schema';
import { FirmSchema } from '../../firms/firm.schema';
import { FyLockService } from '../fy-lock.service';

/**
 * Lock-guard suite (Plan 03 Task 1 step 5).
 *
 * Covers:
 *   1. OPEN FY containing voucher date → no throw.
 *   2. CLOSED FY containing voucher date → throws BadRequestException matching /closed/i.
 *   3. Voucher date outside any FY row → no throw.
 *   4. REOPENED FY containing voucher date → no throw.
 */
describe('FyLockService.assertOpen', () => {
  let FyModel: any;
  let FirmModel: any;
  let service: FyLockService;
  const wsId = new Types.ObjectId();
  const firmId = new Types.ObjectId();

  beforeAll(async () => {
    await startMemoryMongo();
    FyModel = model('FiscalYear', FiscalYearSchema);
    FirmModel = model('Firm', FirmSchema);
    // D21: AuditService is only used on the amendment path; a no-op stub suffices for these tests.
    service = new FyLockService(FyModel, FirmModel, {
      logEvent: () => Promise.resolve(),
    } as unknown as import('../../../audit/audit.service').AuditService);
  });

  afterAll(async () => {
    await stopMemoryMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
  });

  const seedFy = async (status: 'OPEN' | 'CLOSED' | 'REOPENED') => {
    await FyModel.create({
      wsId,
      firmId,
      startDate: new Date('2024-04-01T00:00:00.000Z'),
      endDate: new Date('2025-03-31T23:59:59.999Z'),
      status,
      auditTrail: [],
    });
  };

  it('OPEN FY → no throw', async () => {
    await seedFy('OPEN');
    await expect(
      service.assertOpen(wsId, firmId, new Date('2024-12-15T00:00:00.000Z')),
    ).resolves.toBeUndefined();
  });

  it('CLOSED FY → throws with /closed/i message', async () => {
    await seedFy('CLOSED');
    await expect(
      service.assertOpen(wsId, firmId, new Date('2024-12-15T00:00:00.000Z')),
    ).rejects.toThrow(/closed/i);
  });

  it('voucher date outside any FY → no throw', async () => {
    await seedFy('CLOSED');
    await expect(
      service.assertOpen(wsId, firmId, new Date('2030-01-01T00:00:00.000Z')),
    ).resolves.toBeUndefined();
  });

  it('REOPENED FY → no throw', async () => {
    await seedFy('REOPENED');
    await expect(
      service.assertOpen(wsId, firmId, new Date('2024-12-15T00:00:00.000Z')),
    ).resolves.toBeUndefined();
  });
});
