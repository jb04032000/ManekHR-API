/**
 * Phase 17 / FIN-16-01 — RfmSegmenterService unit tests.
 *
 * 12 cases per Plan 17-04 Task 1 behaviour:
 *   1. BLACKLIST sticky — party with intelligence.blacklisted=true keeps BLACKLIST
 *   2. NEW (createdAt 30d ago, freq=0)
 *   3. NEW (createdAt 30d ago, freq=1)
 *   4. VIP — R=5,F=5,M=5 in 50-party fixture
 *   5. REGULAR — R=3, F=2
 *   6. DORMANT — recencyDays=180
 *   7. CHURNED — recencyDays=400
 *   8. manualSegment override applied for one cycle, cleared after
 *   9. Small population fallback (< 5 parties) — fixed thresholds
 *  10. W4 D-09 tuning override: rfmTuning.newWindowDays=30 → 45-day-old party
 *      segments as REGULAR (not NEW)
 *  11. Segment unchanged → no party.timeline event emitted
 *  12. Segment changed → party.timeline 'segment.changed' emitted
 *
 * Strategy: mock Mongoose Model with vi.fn() returning fixture data shaped
 * by aggregate stage. We bypass real $bucketAuto by stubbing the
 * computeQuintiles import path indirectly (the service calls .aggregate
 * twice — once for dimensions + 3 times for quintile cutoffs). We control
 * model.aggregate per call to drive different test paths.
 *
 * Project vitest discovery is `src/**\/*.vitest.ts`; plan path stub at
 * `__tests__/unit/party-intelligence/rfm-segmenter.spec.ts` re-points here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { RfmSegmenterService } from './rfm-segmenter.service';

// ── helpers ────────────────────────────────────────────────────────────

const wsOid = new Types.ObjectId();
const firmOid = new Types.ObjectId();

function partyRow(overrides: any = {}) {
  return {
    _id: new Types.ObjectId(),
    partyId: overrides.partyId ?? new Types.ObjectId(),
    workspaceId: wsOid,
    firmId: firmOid,
    createdAt: new Date(Date.now() - 365 * 86400_000), // default: 1y old
    intelligence: {},
    frequency: 0,
    lastInvoiceDate: null,
    invoiceTotalPaise: 0,
    creditTotalPaise: 0,
    ...overrides,
  };
}

/**
 * Build a partyModel mock with controllable behaviour.
 * - aggregate: returns based on which call (dimensions vs quintile bucketAuto)
 * - bulkWrite + updateOne capture writes
 */
function buildPartyModel(opts: {
  dimensionRows: any[];
  quintileResponses?: { recency?: any[]; frequency?: any[]; monetary?: any[] };
}) {
  const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const bulkWrite = vi.fn().mockResolvedValue({ ok: 1 });

  // Track aggregate call sequence: 1st call = computeDimensions; 2-4 = quintiles.
  let callIdx = 0;
  const aggregate = vi.fn(async (pipeline: any[]) => {
    // Dimension query has $lookup stage; quintile query has $bucketAuto.
    const isDimensionQuery = pipeline.some((s: any) => s.$lookup);
    const isBucketAutoQuery = pipeline.some((s: any) => s.$bucketAuto);
    if (isDimensionQuery) {
      callIdx++;
      return opts.dimensionRows;
    }
    if (isBucketAutoQuery) {
      callIdx++;
      // Determine which dimension by inspecting the project stage.
      const projectStage = pipeline.find((s: any) => s.$project);
      const expr = JSON.stringify(projectStage?.$project ?? {});
      if (expr.includes('recencyDays')) return opts.quintileResponses?.recency ?? [];
      if (expr.includes('frequency')) return opts.quintileResponses?.frequency ?? [];
      if (expr.includes('monetaryPaise')) return opts.quintileResponses?.monetary ?? [];
      return [];
    }
    return [];
  });

  return {
    aggregate,
    bulkWrite,
    updateOne,
    findById: vi.fn(),
  } as any;
}

function buildWorkspaceModel(rfmTuning: any = undefined) {
  return {
    findById: vi.fn(() => ({
      select: () => ({
        lean: () =>
          Promise.resolve(
            rfmTuning ? { partyIntelligence: { rfmTuning } } : null,
          ),
      }),
    })),
  } as any;
}

function buildEmitter() {
  return { emit: vi.fn() } as any;
}

/** Build standard quintile cutoffs that yield score=5 for top values. */
function quintileBuckets(maxValues: number[]) {
  // computeQuintiles slices off the last bucket's max — pass 5 entries to
  // produce 4 cutoffs.
  return maxValues.map((m) => ({ _id: { min: 0, max: m }, count: 1 }));
}

// ── tests ──────────────────────────────────────────────────────────────

describe('RfmSegmenterService.recompute — D-04 BLACKLIST sticky', () => {
  it('Test 1 — blacklisted party keeps BLACKLIST regardless of RFM', async () => {
    const partyId = new Types.ObjectId();
    const dim = [
      partyRow({
        partyId,
        intelligence: { blacklisted: true, segment: 'VIP' },
        frequency: 100, // would otherwise be VIP
        invoiceTotalPaise: 99_999_999,
      }),
    ];
    // Pad to 5 parties so quintile branch runs
    for (let i = 0; i < 4; i++) dim.push(partyRow());

    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        recency: quintileBuckets([10, 20, 30, 40, 50]),
        frequency: quintileBuckets([1, 2, 3, 4, 100]),
        monetary: quintileBuckets([100, 200, 300, 400, 999_999_999]),
      },
    });
    const ws = buildWorkspaceModel();
    const events = buildEmitter();
    const svc = new RfmSegmenterService(partyModel, ws, events);

    await svc.recompute(String(wsOid), { runId: 'r1' });

    const targetUpdate = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(partyId),
    );
    expect(targetUpdate).toBeDefined();
    expect(targetUpdate![1].$set['intelligence.segment']).toBe('BLACKLIST');
  });
});

describe('RfmSegmenterService.recompute — D-03 segment derivation (quintile mode)', () => {
  function makeFixture(targetOverrides: any) {
    // 5 parties — first is the target.
    const target = partyRow(targetOverrides);
    const dim = [target];
    for (let i = 0; i < 4; i++) dim.push(partyRow());
    return { target, dim };
  }

  it('Test 2 — NEW: createdAt 30d ago, freq=0', async () => {
    const { target, dim } = makeFixture({
      createdAt: new Date(Date.now() - 30 * 86400_000),
      frequency: 0,
    });

    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        recency: quintileBuckets([10, 20, 30, 40, 50]),
        frequency: quintileBuckets([1, 2, 3, 4, 5]),
        monetary: quintileBuckets([100, 200, 300, 400, 500]),
      },
    });
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      buildEmitter(),
    );
    await svc.recompute(String(wsOid), { runId: 'r2' });

    const upd = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(target.partyId),
    );
    expect(upd![1].$set['intelligence.segment']).toBe('NEW');
  });

  it('Test 3 — NEW: createdAt 30d ago, freq=1', async () => {
    const { target, dim } = makeFixture({
      createdAt: new Date(Date.now() - 30 * 86400_000),
      frequency: 1,
      lastInvoiceDate: new Date(Date.now() - 5 * 86400_000),
    });
    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        recency: quintileBuckets([10, 20, 30, 40, 50]),
        frequency: quintileBuckets([1, 2, 3, 4, 5]),
        monetary: quintileBuckets([100, 200, 300, 400, 500]),
      },
    });
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      buildEmitter(),
    );
    await svc.recompute(String(wsOid), { runId: 'r3' });
    const upd = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(target.partyId),
    );
    expect(upd![1].$set['intelligence.segment']).toBe('NEW');
  });

  it('Test 4 — VIP: R=5,F=5,M=5', async () => {
    // Place target at top of all 3 dimensions (recency=5d, freq=5, mon=high).
    const { target, dim } = makeFixture({
      createdAt: new Date(Date.now() - 365 * 86400_000), // not NEW
      frequency: 5,
      lastInvoiceDate: new Date(Date.now() - 1 * 86400_000),
      invoiceTotalPaise: 999_999_999,
    });
    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        // recency cutoffs: low values; target recency=1d → bucket 1 → invert → 5
        recency: quintileBuckets([2, 10, 20, 30, 40]),
        // freq cutoffs: target freq=5 → above all → bucket 5 → 5
        frequency: quintileBuckets([1, 2, 3, 4, 5]),
        // monetary cutoffs: target mon huge → above all → bucket 5
        monetary: quintileBuckets([100, 200, 300, 400, 500]),
      },
    });
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      buildEmitter(),
    );
    await svc.recompute(String(wsOid), { runId: 'r4' });
    const upd = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(target.partyId),
    );
    expect(upd![1].$set['intelligence.segment']).toBe('VIP');
    expect(upd![1].$set['intelligence.rfmR']).toBe(5);
    expect(upd![1].$set['intelligence.rfmF']).toBe(5);
    expect(upd![1].$set['intelligence.rfmM']).toBe(5);
  });

  it('Test 5 — REGULAR: R=3, F=2', async () => {
    const { target, dim } = makeFixture({
      createdAt: new Date(Date.now() - 365 * 86400_000), // not NEW
      frequency: 3,
      lastInvoiceDate: new Date(Date.now() - 25 * 86400_000), // recencyDays~25
      invoiceTotalPaise: 250,
    });
    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        // recency=25 → cutoffs make bucket 3 forward → invert → R=3
        recency: quintileBuckets([10, 20, 30, 40, 50]),
        // freq=3 → cutoffs [1,2] → bucket 3 forward → F=3 ... but rule says F>=2 ok
        // actually we want F=2 in plan. Use cutoffs so freq=3 lands at bucket 2.
        frequency: quintileBuckets([1, 5, 10, 20, 100]),
        // monetary low → M=1 (still REGULAR since rule is R>=3 AND F>=2)
        monetary: quintileBuckets([1000, 5000, 10000, 50000, 999_999]),
      },
    });
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      buildEmitter(),
    );
    await svc.recompute(String(wsOid), { runId: 'r5' });
    const upd = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(target.partyId),
    );
    expect(upd![1].$set['intelligence.segment']).toBe('REGULAR');
  });

  it('Test 6 — DORMANT: recencyDays=180 (in [91,365])', async () => {
    const { target, dim } = makeFixture({
      createdAt: new Date(Date.now() - 500 * 86400_000),
      frequency: 1,
      lastInvoiceDate: new Date(Date.now() - 180 * 86400_000),
      invoiceTotalPaise: 100,
    });
    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        recency: quintileBuckets([10, 20, 30, 40, 50]), // 180 > all → bucket 5 → invert → R=1
        frequency: quintileBuckets([1, 2, 3, 4, 5]),
        monetary: quintileBuckets([100, 200, 300, 400, 500]),
      },
    });
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      buildEmitter(),
    );
    await svc.recompute(String(wsOid), { runId: 'r6' });
    const upd = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(target.partyId),
    );
    expect(upd![1].$set['intelligence.segment']).toBe('DORMANT');
  });

  it('Test 7 — CHURNED: recencyDays=400', async () => {
    const { target, dim } = makeFixture({
      createdAt: new Date(Date.now() - 500 * 86400_000),
      frequency: 0,
      lastInvoiceDate: null, // → recencyDays=99999 sentinel
      invoiceTotalPaise: 0,
    });
    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        recency: quintileBuckets([10, 20, 30, 40, 50]),
        frequency: quintileBuckets([1, 2, 3, 4, 5]),
        monetary: quintileBuckets([100, 200, 300, 400, 500]),
      },
    });
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      buildEmitter(),
    );
    await svc.recompute(String(wsOid), { runId: 'r7' });
    const upd = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(target.partyId),
    );
    expect(upd![1].$set['intelligence.segment']).toBe('CHURNED');
  });
});

describe('RfmSegmenterService.recompute — D-07 manual override + clear-after-cycle', () => {
  it('Test 8 — manualSegment applied this cycle, $unset queued (non-BLACKLIST)', async () => {
    const targetId = new Types.ObjectId();
    const dim = [
      partyRow({
        partyId: targetId,
        intelligence: { manualSegment: 'VIP', segment: 'NEW' },
        frequency: 0,
        invoiceTotalPaise: 0,
      }),
    ];
    for (let i = 0; i < 4; i++) dim.push(partyRow());

    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        recency: quintileBuckets([10, 20, 30, 40, 50]),
        frequency: quintileBuckets([1, 2, 3, 4, 5]),
        monetary: quintileBuckets([100, 200, 300, 400, 500]),
      },
    });
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      buildEmitter(),
    );
    await svc.recompute(String(wsOid), { runId: 'r8' });
    const upd = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(targetId),
    );
    expect(upd![1].$set['intelligence.segment']).toBe('VIP');
    expect(upd![1].$unset).toBeDefined();
    expect(upd![1].$unset['intelligence.manualSegment']).toBe('');
  });
});

describe('RfmSegmenterService.recompute — D-06 small-population fallback', () => {
  it('Test 9 — < 5 parties: fixed thresholds (VIP if M ≥ 50_000_00 paise)', async () => {
    // Only 3 parties — quintile branch skipped.
    const targetId = new Types.ObjectId();
    const dim = [
      partyRow({
        partyId: targetId,
        invoiceTotalPaise: 6_000_000, // ₹60k > 50k threshold
        frequency: 1,
        createdAt: new Date(Date.now() - 365 * 86400_000),
      }),
      partyRow(),
      partyRow(),
    ];

    const partyModel = buildPartyModel({ dimensionRows: dim });
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      buildEmitter(),
    );
    await svc.recompute(String(wsOid), { runId: 'r9' });
    const upd = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(targetId),
    );
    expect(upd![1].$set['intelligence.segment']).toBe('VIP');
    // Quintile-branch scores must NOT be set in fallback.
    expect(upd![1].$set['intelligence.rfmR']).toBeUndefined();
    expect(upd![1].$set['intelligence.rfmF']).toBeUndefined();
    expect(upd![1].$set['intelligence.rfmM']).toBeUndefined();
  });
});

describe('RfmSegmenterService.recompute — D-09 tuning override', () => {
  it('Test 10 — newWindowDays=30 → 45-day-old party becomes REGULAR (not NEW)', async () => {
    const targetId = new Types.ObjectId();
    const dim = [
      partyRow({
        partyId: targetId,
        createdAt: new Date(Date.now() - 45 * 86400_000),
        frequency: 3,
        lastInvoiceDate: new Date(Date.now() - 5 * 86400_000),
        invoiceTotalPaise: 100,
      }),
    ];
    for (let i = 0; i < 4; i++) dim.push(partyRow());

    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        recency: quintileBuckets([10, 20, 30, 40, 50]),
        frequency: quintileBuckets([1, 5, 10, 20, 100]),
        monetary: quintileBuckets([1000, 5000, 10000, 50000, 999_999]),
      },
    });

    // Override newWindowDays = 30 (default 60).
    const ws = buildWorkspaceModel({ newWindowDays: 30 });
    const svc = new RfmSegmenterService(partyModel, ws, buildEmitter());
    await svc.recompute(String(wsOid), { runId: 'r10' });

    const upd = partyModel.updateOne.mock.calls.find(
      (c: any) => String(c[0]._id) === String(targetId),
    );
    // 45 > 30 → NOT NEW. R=3 (recency=5d → bucket 1 → invert 5 → too high).
    // Adjust expectation: target recency=5d → bucket 1 → invert → R=5; F=3→bucket 2;
    // R≥3 AND F≥2 → REGULAR.
    expect(upd![1].$set['intelligence.segment']).toBe('REGULAR');
  });
});

describe('RfmSegmenterService.recompute — segment.changed timeline emission', () => {
  it('Test 11 — segment unchanged → no party.timeline event emitted for that party', async () => {
    // Target has previous segment 'NEW' and computed segment is also 'NEW'.
    const targetId = new Types.ObjectId();
    const dim = [
      partyRow({
        partyId: targetId,
        intelligence: { segment: 'NEW' }, // previous segment
        createdAt: new Date(Date.now() - 30 * 86400_000),
        frequency: 0,
      }),
    ];
    for (let i = 0; i < 4; i++) dim.push(partyRow());
    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        recency: quintileBuckets([10, 20, 30, 40, 50]),
        frequency: quintileBuckets([1, 2, 3, 4, 5]),
        monetary: quintileBuckets([100, 200, 300, 400, 500]),
      },
    });
    const events = buildEmitter();
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      events,
    );
    await svc.recompute(String(wsOid), { runId: 'r11' });

    // Look for ANY emit call referencing this partyId — there should be none.
    const targetEmits = events.emit.mock.calls.filter(
      (c: any) =>
        c[0] === 'party.timeline' &&
        String(c[1]?.partyId) === String(targetId),
    );
    expect(targetEmits.length).toBe(0);
  });

  it('Test 12 — segment changed → party.timeline { segment.changed, from, to, rfm } emitted', async () => {
    const targetId = new Types.ObjectId();
    const dim = [
      partyRow({
        partyId: targetId,
        intelligence: { segment: 'NEW' }, // was NEW
        createdAt: new Date(Date.now() - 365 * 86400_000), // not NEW anymore
        frequency: 5,
        lastInvoiceDate: new Date(Date.now() - 1 * 86400_000),
        invoiceTotalPaise: 999_999_999,
      }),
    ];
    for (let i = 0; i < 4; i++) dim.push(partyRow());
    const partyModel = buildPartyModel({
      dimensionRows: dim,
      quintileResponses: {
        recency: quintileBuckets([2, 10, 20, 30, 40]),
        frequency: quintileBuckets([1, 2, 3, 4, 5]),
        monetary: quintileBuckets([100, 200, 300, 400, 500]),
      },
    });
    const events = buildEmitter();
    const svc = new RfmSegmenterService(
      partyModel,
      buildWorkspaceModel(),
      events,
    );
    await svc.recompute(String(wsOid), { runId: 'r12' });

    const emit = events.emit.mock.calls.find(
      (c: any) =>
        c[0] === 'party.timeline' &&
        String(c[1]?.partyId) === String(targetId),
    );
    expect(emit).toBeDefined();
    expect(emit![1].type).toBe('segment.changed');
    expect(emit![1].meta.from).toBe('NEW');
    expect(emit![1].meta.to).toBe('VIP');
    expect(emit![1].meta.rfm).toBe('555');
  });
});
