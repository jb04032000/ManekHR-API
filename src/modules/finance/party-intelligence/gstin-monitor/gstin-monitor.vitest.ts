/**
 * Phase 17 / FIN-16-02 — GstinMonitorService + Cron unit tests.
 *
 * 8 cases per Plan 17-03 Task 2 behaviour:
 *   1. Cron skips workspaces where local hour !== 3
 *   2. Cron skips workspaces where local weekday !== Sunday
 *   3. Provider success → updates intelligence cache + risk + checkedAt
 *   4. Provider failure → writes ONLY gstinFilingsLastError; risk unchanged
 *   5. Risk UP transition (OK → WATCH) → emits notification + timeline event
 *   6. Risk DOWN transition (WATCH → OK) → silent (no notification, no event)
 *   7. Parties without `gstin` skipped
 *   8. Parties with `isDeleted: true` skipped
 *
 * Project vitest discovery is `src/**\/*.vitest.ts`; plan path stub at
 * `__tests__/unit/party-intelligence/gstin-monitor.spec.ts` re-points here.
 *
 * Mongo-memory-server avoided here — service uses query mocks for unit-scoped
 * speed. Integration test (real Mongo) deferred to Plan 02 backfill style.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { GstinMonitorService } from './gstin-monitor.service';
import { GstinMonitorCron } from './gstin-monitor.cron';
import { gstinPeriodsFixture } from '../../../../../test-utils/gstin-fixtures';
import type { GstinFilingPeriod } from './filing-status.types';

function makeParty(overrides: Partial<any> = {}) {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    firmId: new Types.ObjectId(),
    name: 'Acme Co',
    gstin: '27AABCU9603R1ZX',
    isDeleted: false,
    intelligence: { gstinRiskLevel: 'OK' as const },
    ...overrides,
  };
}

function buildModelMock(parties: any[]) {
  const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const findOne = vi.fn(() => ({ lean: () => Promise.resolve(parties[0] ?? null) }));
  const findById = vi.fn(() => ({
    select: () => ({
      lean: () => Promise.resolve({ intelligence: parties[0]?.intelligence ?? null }),
    }),
  }));
  const find = vi.fn((filter: any) => ({
    lean: () => {
      // Honour isDeleted + gstin filters (cases 7 + 8).
      const filtered = parties.filter((p) => {
        if (filter.isDeleted === false && p.isDeleted === true) return false;
        if (
          filter.gstin?.$exists === true &&
          (!p.gstin || p.gstin === '')
        )
          return false;
        return true;
      });
      return Promise.resolve(filtered);
    },
  }));
  return { find, findOne, findById, updateOne } as any;
}

function buildSurepass(impl?: (gstin: string) => Promise<GstinFilingPeriod[]>) {
  return {
    fetchFilingStatus: vi.fn(impl ?? (async () => [])),
    setFirmGspKey: vi.fn(),
  } as any;
}

function buildNotifications() {
  return {
    createNotification: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function buildEventEmitter() {
  return { emit: vi.fn() } as any;
}

describe('GstinMonitorCron — workspace timezone filter (D-11, Pitfall 9)', () => {
  let cron: GstinMonitorCron;
  beforeEach(() => {
    cron = new GstinMonitorCron({} as any, {} as any);
  });

  it('Test 1: skips when local hour !== 3 (Sunday 04:00 IST → false)', () => {
    // 04:00 IST on a Sunday = 22:30 UTC Saturday. We construct a date such
    // that Asia/Kolkata renders it as Sunday 04:00.
    const sunday0400IST = new Date('2026-04-26T04:00:00+05:30'); // Apr 26 2026 = Sunday
    expect(cron.shouldRunInWorkspaceNow(sunday0400IST, 'Asia/Kolkata')).toBe(false);
  });

  it('Test 2: skips when local weekday !== Sunday (Monday 03:00 IST → false)', () => {
    const monday0300IST = new Date('2026-04-27T03:00:00+05:30'); // Apr 27 2026 = Monday
    expect(cron.shouldRunInWorkspaceNow(monday0300IST, 'Asia/Kolkata')).toBe(false);
  });

  it('returns true on Sunday 03:00 in workspace tz', () => {
    const sunday0300IST = new Date('2026-04-26T03:00:00+05:30');
    expect(cron.shouldRunInWorkspaceNow(sunday0300IST, 'Asia/Kolkata')).toBe(true);
  });
});

describe('GstinMonitorService.runForWorkspace', () => {
  it('Test 3: provider success → updates gstinFilings + risk + checkedAt', async () => {
    const party = makeParty();
    const filings = gstinPeriodsFixture({
      last3Status: ['FILED', 'FILED', 'FILED'],
    });
    const partyModel = buildModelMock([party]);
    const surepass = buildSurepass(async () => filings);
    const svc = new GstinMonitorService(
      partyModel,
      surepass,
      buildNotifications(),
      buildEventEmitter(),
    );

    const summary = await svc.runForWorkspace(
      String(party.workspaceId),
      'run-1',
    );

    expect(summary.checked).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.errored).toBe(0);
    expect(partyModel.updateOne).toHaveBeenCalledTimes(1);
    const setOp = partyModel.updateOne.mock.calls[0][1];
    expect(setOp.$set['intelligence.gstinFilings']).toEqual(filings);
    expect(setOp.$set['intelligence.gstinRiskLevel']).toBe('OK');
    expect(setOp.$set['intelligence.gstinFilingsCheckedAt']).toBeInstanceOf(Date);
    expect(setOp.$unset['intelligence.gstinFilingsLastError']).toBe('');
  });

  it('Test 4: provider failure → writes ONLY gstinFilingsLastError, leaves risk untouched (Pitfall 3 stale-good)', async () => {
    const party = makeParty({
      intelligence: { gstinRiskLevel: 'WATCH', gstinFilings: [{ keep: true }] as any },
    });
    const partyModel = buildModelMock([party]);
    const surepass = buildSurepass(async () => {
      throw new Error('SurePass HTTP 503');
    });
    const svc = new GstinMonitorService(
      partyModel,
      surepass,
      buildNotifications(),
      buildEventEmitter(),
    );

    const summary = await svc.runForWorkspace(
      String(party.workspaceId),
      'run-2',
    );
    expect(summary.errored).toBe(1);
    expect(partyModel.updateOne).toHaveBeenCalledTimes(1);
    const update = partyModel.updateOne.mock.calls[0][1];
    expect(update.$set['intelligence.gstinFilingsLastError']).toBeDefined();
    expect(update.$set['intelligence.gstinFilingsLastError'].message).toContain(
      '503',
    );
    // CRITICAL: risk + filings NOT touched.
    expect(update.$set['intelligence.gstinRiskLevel']).toBeUndefined();
    expect(update.$set['intelligence.gstinFilings']).toBeUndefined();
  });

  it('Test 5: UP transition OK → WATCH emits notification + timeline event', async () => {
    const party = makeParty({
      intelligence: { gstinRiskLevel: 'OK' as const },
    });
    // Build filings so deriveGstinRisk yields WATCH:
    // FILED, NOT_FILED, FILED → asc-sorted [FILED, NOT_FILED, FILED] → WATCH.
    const filings = gstinPeriodsFixture({
      last3Status: ['FILED', 'NOT_FILED', 'FILED'],
    });
    const partyModel = buildModelMock([party]);
    const surepass = buildSurepass(async () => filings);
    const notifications = buildNotifications();
    const events = buildEventEmitter();
    const svc = new GstinMonitorService(
      partyModel,
      surepass,
      notifications,
      events,
    );

    await svc.runForWorkspace(String(party.workspaceId), 'run-3');

    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'party.timeline',
      expect.objectContaining({ type: 'gstin.flag_changed' }),
    );
    const payload = events.emit.mock.calls[0][1];
    expect(payload.meta.from).toBe('OK');
    expect(payload.meta.to).toBe('WATCH');
  });

  it('Test 6: DOWN transition WATCH → OK is silent (D-13)', async () => {
    const party = makeParty({
      intelligence: { gstinRiskLevel: 'WATCH' as const },
    });
    const filings = gstinPeriodsFixture({
      last3Status: ['FILED', 'FILED', 'FILED'],
    });
    const partyModel = buildModelMock([party]);
    const surepass = buildSurepass(async () => filings);
    const notifications = buildNotifications();
    const events = buildEventEmitter();
    const svc = new GstinMonitorService(
      partyModel,
      surepass,
      notifications,
      events,
    );

    await svc.runForWorkspace(String(party.workspaceId), 'run-4');

    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('Test 7: parties without gstin skipped (filter excludes them)', async () => {
    const partyNoGstin = makeParty({ gstin: '' });
    const partyModel = buildModelMock([partyNoGstin]);
    const surepass = buildSurepass();
    const svc = new GstinMonitorService(
      partyModel,
      surepass,
      buildNotifications(),
      buildEventEmitter(),
    );

    const summary = await svc.runForWorkspace(
      String(partyNoGstin.workspaceId),
      'run-5',
    );
    expect(summary.checked).toBe(0);
    expect(surepass.fetchFilingStatus).not.toHaveBeenCalled();
  });

  it('Test 8: parties with isDeleted=true skipped (Security threat)', async () => {
    const partyDeleted = makeParty({ isDeleted: true });
    const partyModel = buildModelMock([partyDeleted]);
    const surepass = buildSurepass();
    const svc = new GstinMonitorService(
      partyModel,
      surepass,
      buildNotifications(),
      buildEventEmitter(),
    );

    const summary = await svc.runForWorkspace(
      String(partyDeleted.workspaceId),
      'run-6',
    );
    expect(summary.checked).toBe(0);
    expect(surepass.fetchFilingStatus).not.toHaveBeenCalled();
  });
});

describe('GstinMonitorService.recheckSingleParty (D-14 rate limit + sync race)', () => {
  it('rejects with rate_limited when called within 1 hour', async () => {
    const party = makeParty();
    const partyModel = buildModelMock([party]);
    const surepass = buildSurepass(async () =>
      gstinPeriodsFixture({ last3Status: ['FILED', 'FILED', 'FILED'] }),
    );
    const svc = new GstinMonitorService(
      partyModel,
      surepass,
      buildNotifications(),
      buildEventEmitter(),
    );

    const wsId = String(party.workspaceId);
    const partyId = String(party._id);
    const first = await svc.recheckSingleParty(wsId, partyId, 'user-1');
    expect(first.status).toBe('updated');

    const second = await svc.recheckSingleParty(wsId, partyId, 'user-1');
    expect(second.status).toBe('rate_limited');
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });
});
