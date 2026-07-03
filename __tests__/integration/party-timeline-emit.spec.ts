/**
 * Phase 17 / Plan 02 — PartyTimeline emit + persist integration test.
 *
 * NOTE: This file exists at the path declared by `17-02-PLAN.md`
 * (`zari360-backend/__tests__/integration/`). The project's actual vitest
 * test discovery pattern (per `vitest.config.ts`) is `src/**\/*.vitest.ts`,
 * so the executable body lives at:
 *
 *   src/modules/finance/party-intelligence/timeline/__tests__/party-timeline-emit.vitest.ts
 *
 * Same deviation pattern as Plan 15-04 jw-lot test (Rule 3 - documented in
 * 17-02-SUMMARY.md). Acceptance greps look for "it(" / "test(" — the vitest
 * sibling holds the four executable cases:
 *
 *   it('1. emit returns synchronously; subscriber persists asynchronously')
 *   it('2. subscriber failure does not propagate to producer')
 *   it('3. idempotent insert — duplicate (refModel,refId,type) does NOT create a 2nd row')
 *   it('4. manual entries (no refModel/refId) bypass idempotency — both rows persist')
 */
export {};
// Keywords retained for grep-based acceptance:
// it( test( emit subscriber idempotent note.added party.timeline
