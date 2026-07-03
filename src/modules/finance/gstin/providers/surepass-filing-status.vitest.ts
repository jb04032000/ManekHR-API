/**
 * Phase 17 / FIN-16-02 D-10 — SurepassProvider.fetchFilingStatus tests.
 *
 * Project vitest discovery is `src/**\/*.vitest.ts`; plan path stub at
 * `__tests__/unit/finance/gstin/surepass-filing-status.spec.ts` re-points here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SurepassProvider, GstinProviderAuthError, GstinProviderError } from './surepass.provider';
import { mockSurepassFilingResponse } from '../../../../../test-utils/gstin-fixtures';

const ORIGINAL_FETCH = global.fetch;

function makeResponse(body: unknown, status = 200, ok = true): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('SurepassProvider.fetchFilingStatus (D-10)', () => {
  let provider: SurepassProvider;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    provider = new SurepassProvider();
    process.env.SUREPASS_API_KEY = 'test-key-NEVER-LOG';
    delete process.env.SUREPASS_FILING_STUB;
    delete process.env.SUREPASS_FILING_API_KEY;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    Object.assign(process.env, originalEnv);
    delete process.env.SUREPASS_FILING_STUB;
    delete process.env.SUREPASS_FILING_API_KEY;
    vi.restoreAllMocks();
  });

  it('happy path: HTTP 200 → returns sorted-asc GstinFilingPeriod[] capped to requested count', async () => {
    const body = mockSurepassFilingResponse({
      gstin: '27AABCU9603R1ZX',
      periodsAllFiled: true,
      count: 6,
    });
    global.fetch = vi.fn(async () => makeResponse(body, 200, true)) as any;

    const out = await provider.fetchFilingStatus('27AABCU9603R1ZX', 6);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].return).toBe('GSTR-3B');
    expect(typeof out[0].period).toBe('string');
    // Sorted ascending by period (oldest first).
    for (let i = 1; i < out.length; i++) {
      const [am, ay] = out[i - 1].period.split('-').map((n) => parseInt(n, 10));
      const [bm, by] = out[i].period.split('-').map((n) => parseInt(n, 10));
      const aDate = new Date(ay, am - 1, 1).getTime();
      const bDate = new Date(by, bm - 1, 1).getTime();
      expect(bDate).toBeGreaterThanOrEqual(aDate);
    }
    // All FILED status mapped correctly.
    expect(out.every((p) => p.status === 'FILED')).toBe(true);
  });

  it('HTTP 5xx throws GstinProviderError (non-auth)', async () => {
    global.fetch = vi.fn(async () =>
      makeResponse({}, 503, false),
    ) as any;
    await expect(
      provider.fetchFilingStatus('27AABCU9603R1ZX', 6),
    ).rejects.toBeInstanceOf(GstinProviderError);
  });

  it('HTTP 401 throws GstinProviderAuthError (auth subclass for cron loud-warn)', async () => {
    global.fetch = vi.fn(async () =>
      makeResponse({}, 401, false),
    ) as any;
    await expect(
      provider.fetchFilingStatus('27AABCU9603R1ZX', 6),
    ).rejects.toBeInstanceOf(GstinProviderAuthError);
  });

  it('empty response: data.filing_status missing → returns []', async () => {
    global.fetch = vi.fn(async () =>
      makeResponse({ data: {}, success: true }, 200, true),
    ) as any;
    const out = await provider.fetchFilingStatus('27AABCU9603R1ZX', 6);
    expect(out).toEqual([]);
  });

  it('SUREPASS_FILING_STUB=true short-circuits to []', async () => {
    process.env.SUREPASS_FILING_STUB = 'true';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const out = await provider.fetchFilingStatus('27AABCU9603R1ZX', 6);
    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
