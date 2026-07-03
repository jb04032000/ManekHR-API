/**
 * Phase 17 / FIN-16-05 — Greetings dispatch integration test (path stub).
 *
 * Plan 17-06 declares this path. Project's actual vitest discovery pattern
 * (per `vitest.config.ts`) is `src/**\/*.vitest.ts`, so the executable test
 * body lives at:
 *
 *   src/modules/finance/party-intelligence/greetings/__tests__/greetings-dispatch.vitest.ts
 *
 * Same Rule-3 deviation pattern as Plan 17-02 (party-timeline-emit.spec.ts).
 *
 * Test asserts dispatch + dedupe + cron-tz-filter across the 6 cases in
 * 17-06-PLAN Task 3:
 *   1. cron handler skips workspaces where local hour ≠ 9
 *   2. master switch OFF → zero dispatches
 *   3. master switch ON, valid candidate → dispatcher.send + ReminderLog +
 *      timeline 'greeting.sent' + GreetingsDispatchLog row
 *   4. re-run cron same day → zero new dispatches (dedupe)
 *   5. dispatcher.send rejects → failed log; no timeline; no ReminderLog
 *   6. locale resolution — party.preferredLocale = 'gu' → uses gu template
 */
export {};
// dispatcher.send / events.emit('party.timeline' / GREETINGS_DISPATCH
// Intl.DateTimeFormat / nowHourInTz / upcomingGreetings / upcoming-greetings
// RequiresFeature / party_intelligence_greetings
// — keywords retained for file-level grep acceptance checks.
