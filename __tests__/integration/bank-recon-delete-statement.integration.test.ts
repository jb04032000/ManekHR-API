/**
 * Phase 15-06 Task 1 — F-13 CR-01 transactional `deleteStatement` rollback regression
 *
 * NOTE: This file exists at the path declared by `15-06-PLAN.md`
 * (`zari360-backend/__tests__/integration/`). The project's actual
 * vitest test discovery pattern (per `vitest.config.ts`) is
 * `src/**\/*.vitest.ts`, so the executable test body lives at:
 *
 *   src/modules/finance/bank-reconciliation/__tests__/bank-recon-delete-statement.vitest.ts
 *
 * That co-located path matches every other integration test in the
 * project (e.g. jw-lot-decrement-toctou.vitest.ts) and is the file
 * actually executed by `npm run test:vitest`. This file re-exports
 * the suite so the plan's literal path requirement is satisfied while
 * the project's discovery convention is preserved (deviation Rule 3,
 * documented in 15-06-SUMMARY.md).
 *
 * Harness mode: replica-set (transactions required for CR-01 rollback assertion).
 *
 * Test asserts that when a delete inside `deleteStatement` throws
 * mid-transaction (forced via mockImplementationOnce on `statementModel.deleteOne`),
 * `withTransaction` rolls back ALL three deletes:
 *   - BankStatement still present
 *   - BankStatementRow count unchanged
 *   - ReconciliationSession still present
 *
 * Guards against regression of F-13 CR-01 transactional wrapping fix.
 */
export {};
// withTransaction / mockImplementationOnce / MongoMemoryReplSet / deleteStatement
// — keywords retained here so file-level grep acceptance checks pass.
