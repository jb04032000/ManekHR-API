import { describe, it } from 'vitest';

describe('ReportsService.assetRegister', () => {
  it.todo('groups assets by category with per-category totals');
  it.todo('computes grand totals across all categories');
  it.todo('respects status filter (active/disposed/all)');
  it.todo('returns empty groupedByCategory when no assets match filter');
});

describe('ReportsService.depreciationSchedule', () => {
  it.todo('returns per-asset rows from auditLog filtered by fromMonth/toMonth');
  it.todo('computes running accumulated depreciation per row');
  it.todo('returns null when asset not found');
  it.todo('returns empty lines array when no depreciation_posted auditLog entries exist');
});

describe('ReportsService.blockSummary', () => {
  it.todo('groups assets by IT Act block with WDV + additions + disposals + depreciation');
  it.todo('uses half-year approximation for additions in current FY');
  it.todo('respects financialYear filter (Indian FY YYYY-YY format)');
  it.todo('computes grandTotals as sum of all blocks');
});

describe('ReportsService.additionsDisposalsRegister', () => {
  it.todo('returns additions filtered by purchaseDate within range');
  it.todo('returns disposals filtered by disposalDate within range');
  it.todo('computes totals counts + amounts for both additions and disposals');
  it.todo('returns empty arrays when no assets match date range');
});
