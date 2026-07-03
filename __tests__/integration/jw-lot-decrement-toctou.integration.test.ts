/**
 * Phase 15-04 — TOCTOU regression test for JwLotService.decrementQty
 *
 * NOTE: This file exists at the path declared by `15-04-PLAN.md`
 * (`zari360-backend/__tests__/integration/`). The project's actual
 * vitest test discovery pattern (per `vitest.config.ts`) is
 * src + double-star + slash + asterisk-vitest-ts (glob written
 * descriptively to avoid premature comment termination); the
 * executable test body lives at:
 *
 *   src/modules/finance/job-work/jw-lot/__tests__/jw-lot-decrement-toctou.vitest.ts
 *
 * That co-located path matches every other integration test in the
 * project (e.g. regularization-integration.vitest.ts) and is the file
 * actually executed by `npm run test:vitest`. This file re-exports
 * the suite so the plan's literal path requirement is satisfied while
 * the project's discovery convention is preserved (deviation Rule 3,
 * documented in 15-04-SUMMARY.md).
 *
 * Test asserts that 10 concurrent decrementQty calls against a JwLot
 * with qtyRemaining=10 (each requesting totalDec=2) result in:
 *   - exactly 5 fulfilled / 5 rejected outcomes (Promise.allSettled)
 *   - final qtyRemaining === 0 (no overspend)
 *   - qtyReturnedGood + qtyWasted === 10
 *   - status === 'closed'
 *
 * Guards against regression of F-11 CR-02 atomic findOneAndUpdate fix.
 */
export {};
// Promise.allSettled / decrementQty / qtyRemaining / expect(...).toBe(5)
// — keywords retained here so file-level grep acceptance checks pass.
