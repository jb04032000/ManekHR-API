import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { PartySalesAggregateService } from './party-sales-aggregate.service';
import { PartySalesAggregate } from './party-sales-aggregate.schema';

// ─── Model mock factory ──────────────────────────────────────────────────────

function makeMockModel(findOneAndUpdateResult: any = null) {
  const execMock = jest.fn().mockResolvedValue(findOneAndUpdateResult);
  const findOneAndUpdateMock = jest.fn().mockReturnValue({ exec: execMock });
  return { findOneAndUpdate: findOneAndUpdateMock, _execMock: execMock };
}

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const workspaceId = new Types.ObjectId().toString();
const firmId = new Types.ObjectId().toString();
const partyId = new Types.ObjectId().toString();
const fy = '2025-26';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PartySalesAggregateService', () => {
  let service: PartySalesAggregateService;
  let mockModel: ReturnType<typeof makeMockModel>;

  async function buildService(findOneAndUpdateResult: any = null) {
    mockModel = makeMockModel(findOneAndUpdateResult);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartySalesAggregateService,
        { provide: getModelToken(PartySalesAggregate.name), useValue: mockModel },
      ],
    }).compile();

    service = module.get<PartySalesAggregateService>(PartySalesAggregateService);
  }

  // ── computeTcs pure tests ──────────────────────────────────────────────────

  describe('computeTcs', () => {
    beforeEach(async () => {
      await buildService(); // model not used for pure computeTcs tests
    });

    it('aato_below_threshold_returns_zero: firm.aato <= 100 → TCS = 0', () => {
      expect(service.computeTcs(10_00_000_00, 0, { aato: 50 })).toBe(0);
      expect(service.computeTcs(10_00_000_00, 0, { aato: 100 })).toBe(0);
    });

    it('before_threshold_no_crossing: cumulative stays below ₹50L → TCS = 0', () => {
      // before = ₹10L paise, taxable = ₹5L paise; after = ₹15L (< ₹50L)
      // 1 lakh INR = 1,00,000 × 100 paise = 1,00,00,000 = 1_00_00_000? No:
      // 1 rupee = 100 paise. 1 lakh rupees = 1,00,000 rupees = 1,00,00,000 paise? No:
      // 1,00,000 rupees × 100 paise/rupee = 1,00,00,000 paise = 1_00_00_000.
      // Wait: 1 lakh = 100,000. 100,000 × 100 = 10,000,000 paise = 10_000_000.
      // ₹50L = 5,000,000 INR = 500,000,000 paise = 5_000_000_00. ✓ (matches const)
      // For this test: before=10L INR in paise = 10×10_000_000 = 100_000_000 = 1_00_000_000
      // taxable = 5L INR = 5×10_000_000 = 50_000_000
      // after = 150_000_000 which is 15L INR < 50L INR → 0 TCS

      const beforePaise = 100_000_000;  // ₹10L in paise
      const taxablePaise = 50_000_000;  // ₹5L in paise
      expect(service.computeTcs(taxablePaise, beforePaise, { aato: 200 })).toBe(0);
    });

    it('first_crossing_marginal: TCS only on portion above ₹50L threshold', () => {
      // TCS_THRESHOLD_PAISE = 5_000_000_00 = 500_000_000
      // before = 49L INR = 49 × 10_000_000 = 490_000_000 paise
      // taxable = 2L INR = 2 × 10_000_000 = 20_000_000 paise
      // after = 510_000_000 → crosses threshold
      // marginal = 510_000_000 - 500_000_000 = 10_000_000 paise
      // TCS = Math.round(10_000_000 × 0.001) = 10_000 paise = ₹100

      const beforePaise = 490_000_000;  // ₹49L
      const taxablePaise = 20_000_000;  // ₹2L
      const tcs = service.computeTcs(taxablePaise, beforePaise, { aato: 200 });
      expect(tcs).toBe(10_000);  // ₹100 = 10,000 paise
    });

    it('subsequent_invoice_full_amount: already above threshold → TCS on full invoice', () => {
      // before = ₹60L = 600_000_000 paise (already above 500_000_000 threshold)
      // taxable = ₹10L = 100_000_000 paise
      // TCS = Math.round(100_000_000 × 0.001) = 100_000 paise = ₹1,000

      const beforePaise = 600_000_000;  // ₹60L
      const taxablePaise = 100_000_000; // ₹10L
      const tcs = service.computeTcs(taxablePaise, beforePaise, { aato: 200 });
      expect(tcs).toBe(100_000);  // ₹1,000 = 1,00,000 paise
    });
  });

  // ── upsertAndGet tests ────────────────────────────────────────────────────

  describe('upsertAndGet', () => {
    it('returns beforePaise=0 when document did not exist (null result)', async () => {
      await buildService(null);  // findOneAndUpdate resolves to null (first upsert)

      const result = await service.upsertAndGet(workspaceId, firmId, partyId, fy, 10_000_000);
      expect(result.beforePaise).toBe(0);
      expect(result.afterPaise).toBe(10_000_000);
    });

    it('returns beforePaise from existing document', async () => {
      const existingDoc = { totalSalesPaise: 490_000_000 };
      await buildService(existingDoc);

      const result = await service.upsertAndGet(workspaceId, firmId, partyId, fy, 20_000_000);
      expect(result.beforePaise).toBe(490_000_000);
      expect(result.afterPaise).toBe(510_000_000);
    });

    it('revert: calls findOneAndUpdate with negative $inc', async () => {
      await buildService(null);

      await service.revert(workspaceId, firmId, partyId, fy, 10_000_000);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ financialYear: fy }),
        { $inc: { totalSalesPaise: -10_000_000 } },
        expect.objectContaining({}),
      );
    });
  });
});
