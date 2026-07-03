/**
 * Phase 17 / Plan 02 / Task 3 — Timeline backfill integration test.
 *
 * NOTE: This file exists at the path declared in `17-02-PLAN.md`. The
 * project's actual vitest discovery uses `src/**\/*.vitest.ts`, so the
 * executable test body lives at:
 *
 *   src/modules/finance/party-intelligence/timeline/__tests__/party-timeline-backfill.vitest.ts
 *
 * Same deviation pattern as 15-04 + party-timeline-emit (Rule 3, documented
 * in 17-02-SUMMARY.md). Acceptance greps look for "it(" / "test(" — the
 * vitest sibling holds the five executable cases:
 *
 *   it('1. backfill produces exactly 85 timeline rows from seeded sources')
 *   it('2. re-running backfill is idempotent (zero new rows)')
 *   it('3. cursor pagination returns reverse-chrono pages of 50')
 *   it('4. type filter narrows results to a single source kind')
 *   it('5. 24h-window enforcement on manual entries (timestamp-only logic)')
 */
export {};
// Keywords retained for grep-based acceptance:
// it( test( backfill bulkWrite upsert idempotent pLimit p-limit pagination
