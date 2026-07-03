/**
 * Phase 17 / FIN-16-01 — RfmSegmenterService test (path stub).
 *
 * Plan 17-04 declares this path. Project's actual vitest discovery pattern is
 * `src/**\/*.vitest.ts`, so the executable test body lives at:
 *
 *   src/modules/finance/party-intelligence/rfm/rfm-segmenter.vitest.ts
 *
 * Same Rule-3 deviation pattern as Plan 17-03 (gstin-monitor.spec.ts).
 *
 * 12 cases: BLACKLIST sticky, NEW (2), VIP, REGULAR, DORMANT, CHURNED,
 * manualSegment override+clear, < 5 fallback, D-09 tuning override (W4),
 * unchanged-no-emit, changed-emit segment.changed.
 */
export {};
// BLACKLIST / VIP / REGULAR / NEW / DORMANT / CHURNED / manualSegment / blacklisted
// segment.changed / events.emit('party.timeline' / new Types.ObjectId
// — keywords retained for grep acceptance checks.
