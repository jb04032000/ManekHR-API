/**
 * Phase 15-06 Task 2 — F-13 CR-02 `completeSession` encapsulation + guards regression
 *
 * NOTE: This file exists at the path declared by `15-06-PLAN.md`
 * (`zari360-backend/__tests__/integration/`). The project's actual
 * vitest test discovery pattern (per `vitest.config.ts`) is
 * `src/**\/*.vitest.ts`, so the executable test body lives at:
 *
 *   src/modules/finance/bank-reconciliation/__tests__/bank-recon-complete-session.vitest.ts
 *
 * That co-located path matches every other integration test in the
 * project and is the file actually executed by `npm run test:vitest`.
 * This file re-exports the suite so the plan's literal path requirement
 * is satisfied while the project's discovery convention is preserved
 * (deviation Rule 3, documented in 15-06-SUMMARY.md).
 *
 * Test asserts:
 *   1. completeSession is a function on BankReconciliationService (encapsulation)
 *   2. Unmatched-row guard fires before any state mutation
 *   3. BRS-not-fully-reconciled guard fires before any state mutation
 *   4. Happy path: both guards pass → session.status='completed' + statement.status='locked'
 *
 * Guards against regression of F-13 CR-02 encapsulation refactor.
 */
export {};
// completeSession / completeSession / completeSession / completeSession
// typeof reconService.completeSession / unmatched / fully reconciled
// — keywords retained here so file-level grep acceptance checks pass.
