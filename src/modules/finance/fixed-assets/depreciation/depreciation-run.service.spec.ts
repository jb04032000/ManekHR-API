import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DepreciationRunService } from './depreciation-run.service';
import { DepreciationMathService } from './depreciation-math.service';

describe('DepreciationRunService', () => {
  // Stubs for all dependencies — focus tests on orchestration logic.
  let runModel: any;
  let assetModel: any;
  let categoryModel: any;
  let math: DepreciationMathService;
  let ledgerPosting: any;
  let svc: DepreciationRunService;

  beforeEach(() => {
    runModel = {
      create: vi.fn(),
      findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
      find: vi.fn().mockReturnValue({
        sort: () => ({ limit: () => ({ exec: () => Promise.resolve([]) }) }),
      }),
    };
    assetModel = {
      find: vi.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
      aggregate: vi.fn().mockResolvedValue([]),
    };
    categoryModel = {};
    math = new DepreciationMathService();
    ledgerPosting = { postDepreciation: vi.fn().mockResolvedValue({ _id: 'ledger-entry-1' }) };
    svc = new DepreciationRunService(runModel, assetModel, categoryModel, math, ledgerPosting);
  });

  it('rejects future runMonth', async () => {
    await expect(svc.runForFirm('ws1', 'firm1', '2099-12', 'manual', 'user1')).rejects.toThrow(/future/);
  });

  it('rejects malformed runMonth', async () => {
    await expect(svc.runForFirm('ws1', 'firm1', 'bad-month', 'manual', 'user1')).rejects.toThrow(/YYYY-MM/);
  });

  it('returns existing run on E11000 duplicate (idempotency)', async () => {
    const existingRun = {
      _id: 'run-abc',
      status: 'completed',
      assetsProcessed: 3,
      assetsSkipped: 0,
      totalDepreciationPaise: 150000,
      ledgerEntryIds: [],
      errorMessage: undefined,
    };
    runModel.create = vi.fn().mockRejectedValue({ code: 11000 });
    runModel.findOne = vi.fn().mockReturnValue({ exec: () => Promise.resolve(existingRun) });

    const result = await svc.runForFirm('ws1', 'firm1', '2026-03', 'manual', 'user1');
    expect(result.runId).toBe('run-abc');
    expect(result.status).toBe('completed');
    expect(result.assetsProcessed).toBe(3);
    // postDepreciation must NOT have been called
    expect(ledgerPosting.postDepreciation).not.toHaveBeenCalled();
  });

  it('skips quarterly asset when runMonth is not in 01/04/07/10', async () => {
    const quarterlyAsset = {
      _id: 'asset-q1',
      assetCode: 'FA/25-26/0001',
      name: 'Machinery',
      depreciationFrequency: 'quarterly',
      depreciationMethod: 'slm',
      isFullyDepreciated: false,
      isDeleted: false,
      status: 'active',
      nextDepreciationMonth: '2026-03',
      costPaise: 5000000,
      salvageValuePaise: 250000,
      depreciableAmountPaise: 4750000,
      usefulLifeYears: 15,
      nbvPaise: 4750000,
      accumulatedDepreciationPaise: 0,
      purchaseDate: new Date('2026-01-01'),
      categorySnapshot: { slmRate: 0.0633, wdvRate: 0.181, isNesd: false },
      slmRateOverride: null,
      wdvRateOverride: null,
      shiftType: 'single',
      financialYear: '2025-26',
      auditLog: [],
      save: vi.fn().mockResolvedValue(undefined),
    };

    runModel.create = vi.fn().mockResolvedValue({
      _id: 'run-1',
      assetsProcessed: 0,
      assetsSkipped: 0,
      totalDepreciationPaise: 0,
      ledgerEntryIds: [],
      status: 'completed',
      save: vi.fn(),
    });
    assetModel.find = vi.fn().mockReturnValue({ exec: () => Promise.resolve([quarterlyAsset]) });

    // runMonth '2026-03' (March) is NOT a quarter month (only 01/04/07/10 are)
    const result = await svc.runForFirm('ws1', 'firm1', '2026-03', 'monthly', 'user1');
    expect(result.assetsSkipped).toBe(1);
    expect(result.assetsProcessed).toBe(0);
    expect(ledgerPosting.postDepreciation).not.toHaveBeenCalled();
  });

  it('sets isFullyDepreciated=true when nbv reaches salvage value', async () => {
    const nearlyDepreciatedAsset: any = {
      _id: 'asset-nd1',
      assetCode: 'FA/25-26/0002',
      name: 'Computer',
      depreciationFrequency: 'monthly',
      depreciationMethod: 'slm',
      isFullyDepreciated: false,
      isDeleted: false,
      status: 'active',
      nextDepreciationMonth: '2026-03',
      costPaise: 100000,
      salvageValuePaise: 5000,
      depreciableAmountPaise: 95000,
      usefulLifeYears: 3,
      nbvPaise: 5500,   // Just above salvage — one more period should cap it
      accumulatedDepreciationPaise: 94500,
      purchaseDate: new Date('2023-04-01'),
      categorySnapshot: { slmRate: 0.3333, wdvRate: 0.5, isNesd: false },
      slmRateOverride: null,
      wdvRateOverride: null,
      shiftType: 'single',
      financialYear: '2025-26',
      auditLog: [],
      save: vi.fn().mockResolvedValue(undefined),
    };

    const mockRun: any = {
      _id: 'run-2',
      assetsProcessed: 0,
      assetsSkipped: 0,
      totalDepreciationPaise: 0,
      ledgerEntryIds: [],
      status: 'pending',
      errorMessage: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
    runModel.create = vi.fn().mockResolvedValue(mockRun);
    assetModel.find = vi.fn().mockReturnValue({ exec: () => Promise.resolve([nearlyDepreciatedAsset]) });
    ledgerPosting.postDepreciation = vi.fn().mockResolvedValue({ _id: 'entry-x' });

    const result = await svc.runForFirm('ws1', 'firm1', '2026-03', 'manual', 'user1');
    expect(result.assetsProcessed).toBe(1);
    // The asset should now be marked fully deprecated
    expect(nearlyDepreciatedAsset.isFullyDepreciated).toBe(true);
  });

  it('continues processing other assets when one asset throws an error', async () => {
    const badAsset: any = {
      _id: 'asset-bad',
      assetCode: 'FA/25-26/0003',
      name: 'Bad Asset',
      depreciationFrequency: 'monthly',
      depreciationMethod: 'slm',
      isFullyDepreciated: false,
      isDeleted: false,
      status: 'active',
      nextDepreciationMonth: '2026-03',
      costPaise: 100000,
      salvageValuePaise: 5000,
      depreciableAmountPaise: 95000,
      usefulLifeYears: 3,
      nbvPaise: 90000,
      accumulatedDepreciationPaise: 5000,
      purchaseDate: new Date('2023-04-01'),
      categorySnapshot: { slmRate: 0.3333, wdvRate: 0.5, isNesd: false },
      slmRateOverride: null,
      wdvRateOverride: null,
      shiftType: 'single',
      financialYear: '2025-26',
      auditLog: [],
      save: vi.fn().mockRejectedValue(new Error('DB write error')),
    };

    const goodAsset: any = {
      _id: 'asset-good',
      assetCode: 'FA/25-26/0004',
      name: 'Good Asset',
      depreciationFrequency: 'monthly',
      depreciationMethod: 'slm',
      isFullyDepreciated: false,
      isDeleted: false,
      status: 'active',
      nextDepreciationMonth: '2026-03',
      costPaise: 100000,
      salvageValuePaise: 5000,
      depreciableAmountPaise: 95000,
      usefulLifeYears: 3,
      nbvPaise: 90000,
      accumulatedDepreciationPaise: 5000,
      purchaseDate: new Date('2023-04-01'),
      categorySnapshot: { slmRate: 0.3333, wdvRate: 0.5, isNesd: false },
      slmRateOverride: null,
      wdvRateOverride: null,
      shiftType: 'single',
      financialYear: '2025-26',
      auditLog: [],
      save: vi.fn().mockResolvedValue(undefined),
    };

    const mockRun: any = {
      _id: 'run-3',
      assetsProcessed: 0,
      assetsSkipped: 0,
      totalDepreciationPaise: 0,
      ledgerEntryIds: [],
      status: 'pending',
      errorMessage: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };

    runModel.create = vi.fn().mockResolvedValue(mockRun);
    assetModel.find = vi.fn().mockReturnValue({ exec: () => Promise.resolve([badAsset, goodAsset]) });
    ledgerPosting.postDepreciation = vi.fn().mockResolvedValue({ _id: 'entry-y' });

    const result = await svc.runForFirm('ws1', 'firm1', '2026-03', 'manual', 'user1');
    // goodAsset should still be processed despite badAsset failing
    expect(result.assetsProcessed).toBe(1);
    expect(result.errorMessages.length).toBeGreaterThan(0);
    // Run should not be 'failed' because one asset succeeded
    expect(result.status).toBe('completed');
  });

  it.todo('basic SLM run: posts one entry per asset and updates accumulatedDepreciationPaise + nbvPaise');
  it.todo('basic WDV run: same as SLM but uses WDV rate against current nbv');
  it.todo('backdated catch-up: asset.nextDepreciationMonth < runMonth posts one entry per missed month');
});
