import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DisposalService } from './disposal.service';
import { ItcReversalService } from './itc-reversal.service';
import { DepreciationMathService } from '../depreciation/depreciation-math.service';

/**
 * DisposalService unit tests.
 *
 * Full integration tests require a live MongoDB instance (transactions).
 * These specs test the preview calculation path and guard logic in isolation.
 */
describe('DisposalService — preview gain/loss calculation', () => {
  it.todo('preview returns positive gainLossPaise (gain) when proceeds > NBV');
  it.todo('preview returns negative gainLossPaise (loss) when proceeds < NBV');
  it.todo('preview includes partialMonthDepreciationPaise > 0 when cron has not covered disposal month');
  it.todo('preview sets partialMonthDepreciationPaise = 0 when lastDepreciationMonth >= disposal month (race-condition guard)');
  it.todo('preview returns ITC reversal with applicable=true when itcClaimedPaise > 0 and disposed within 60 months');
  it.todo('preview returns ITC reversal with applicable=false when itcClaimedPaise = 0');
});

describe('DisposalService — dispose guard logic', () => {
  it.todo('dispose throws 422 when itcReversal.applicable && acknowledgeItcReversal is not true');
  it.todo('dispose throws 400 when disposalType=scrap and disposalProceedsPaise > 0');
  it.todo('dispose throws 400 when disposalProceedsPaise > 0 but cashOrBankAccountCode is missing');
  it.todo('dispose updates asset status to "disposed" for sale/writeoff disposalType');
  it.todo('dispose updates asset status to "scrapped" for scrap disposalType');
  it.todo('dispose sets asset nbvPaise=0 and accumulatedDepreciationPaise=costPaise after disposal');
  it.todo('dispose pushes auditLog entry with action matching disposalType');
});

describe('DisposalService — transfer guard logic', () => {
  it.todo('transfer throws 400 when neither locationId nor custodianMemberId is provided');
  it.todo('transfer updates locationId when provided');
  it.todo('transfer updates custodianMemberId when provided');
  it.todo('transfer pushes auditLog entry with action="transferred"');
});

describe('DisposalService — partial month depreciation helper', () => {
  it.todo('returns 0 when asset.isFullyDepreciated=true');
  it.todo('returns 0 when lastDepreciationMonth >= disposal month (cron already covered)');
  it.todo('returns pro-rata amount for mid-month disposal (SLM)');
  it.todo('returns pro-rata amount for mid-month disposal (WDV)');
});
