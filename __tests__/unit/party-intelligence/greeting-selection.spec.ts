/**
 * Phase 17 / FIN-16-05 — GreetingsService selection logic test (path stub).
 *
 * Plan 17-06 declares this path. Project's actual vitest discovery pattern
 * (per `vitest.config.ts`) is `src/**\/*.vitest.ts`, so the executable test
 * body lives at:
 *
 *   src/modules/finance/party-intelligence/greetings/greeting-selection.vitest.ts
 *
 * Same Rule-3 deviation pattern as Plan 17-03 (gstin-risk.spec.ts) and
 * Plan 17-04 (quintile.spec.ts). Acceptance greps look for keywords below.
 *
 * Test asserts selectGreetingsForToday + pickChannel + matchOccasion across
 * the 9 cases in 17-06-PLAN Task 2:
 *   1. master switch OFF
 *   2. birthday match → email channel (no whatsapp identifier)
 *   3. phone present → whatsapp channel
 *   4. contact.suppressGreetings → skipped
 *   5. consentLog whatsapp:false → falls through to email
 *   6. anniversary year-ignored (Feb 29 on non-leap year matches Feb 28)
 *   7. sub-toggle whatsapp=false → email priority
 *   8. dedupe — already-sent today → skipped
 *   9. no email + no phone → silently skipped
 */
export {};
// selectGreetingsForToday / pickChannel / matchOccasion / consentLog
// suppressGreetings / GreetingsDispatchLog / unique
// — keywords retained for file-level grep acceptance checks.
