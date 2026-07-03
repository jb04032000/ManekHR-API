# Advance Reporting-Person Review (Phase 3a) — Implementation Plan

> Use superpowers:test-driven-development. Steps `- [ ]`.

**Goal:** A member's **reporting person** (their `reportsTo` manager) can SEE and **verify** their direct reports' advance requests — advisory only (does NOT gate the owner, who still sees everything and never waits). Permission-gated via a new grantable Team permission, so a company can withhold it. Anti-fraud: the requester enters their own amount; the manager can flag/verify but a manager can never verify their OWN request.

**Architecture:** Mirror the existing `REQUEST_ADVANCE` self-service permission exactly — a new `ModuleAction.REVIEW_ADVANCE`, gated on the endpoints, surfaced as a grantable row in the web `PermissionGrid` salary block. Visibility is a `reportsTo`-FILTERED read endpoint (NOT a new generic RBAC scope). Verify writes advisory fields on the request. The dormant `TeamMember.reportsTo` self-FK is the routing graph.

**Tech Stack:** NestJS + Mongoose + class-validator; Next.js + AntD v6 + next-intl; vitest.

**Spec:** `docs/superpowers/specs/2026-06-22-advance-salary-workflow-design.md` §5.5, §6.3. Phase 3b (eligibility caps) is a separate plan.

**Conventions:** per-file vitest only (OOM); `npm run build` SWC; AntD v6; audit writes; comments (no em-dash); commit path-scoped, never `git add -A`, never stage concurrent WIP (app/messages/\*); new web strings via `t(key,{defaultValue})`.

---

## File Structure

**Backend**

- `src/common/enums/modules.enum.ts` — add `REVIEW_ADVANCE = 'review_advance'` to ModuleAction (next to REQUEST_ADVANCE, with a comment).
- `src/modules/salary/schemas/advance-salary-request.schema.ts` — add `verifiedBy?` (ObjectId ref User), `verifiedAt?` (Date), `verifyNote?` (string).
- `src/modules/salary/advance-salary-request.service.ts` — `listForMyReports(workspaceId, reviewerTeamMemberId)` (requests of members whose reportsTo == reviewer) + `verifyRequest(workspaceId, requestId, reviewerUserId, reviewerTeamMemberId, note)` (SoD: not own; report must actually report to reviewer).
- `src/modules/salary/advance-salary-request.controller.ts` — `GET /advance-requests/for-my-reports` + `PATCH /advance-requests/:requestId/verify`, both `@RequirePermissions(SALARY, REVIEW_ADVANCE, 'self')` + caller's teamMemberId via CallerScopeService (declared before the parameterised owner routes).
- `src/modules/salary/dto/advance-salary-request.dto.ts` — `VerifyAdvanceRequestDto { @IsOptional @IsString @MaxLength(500) note? }`.
- (Role seeder) `src/modules/rbac/role-seeder.constants.ts` — IF a Manager preset exists, grant `(SALARY, REVIEW_ADVANCE, 'self')` to it; otherwise leave ungranted (owner grants per-member). Do NOT broadly auto-grant.
- Tests: `src/modules/salary/__tests__/advance-review.vitest.ts`.

**Web**

- `components/rbac/PermissionGrid.tsx` — add `{ name: 'review_advance', scoped: true }` to the salary actions row (mirror `request_advance`).
- `types/index.ts` — `AdvanceSalaryRequest` gains `verifiedBy?`, `verifiedAt?`, `verifyNote?`; add review payload type.
- `lib/api/modules/salary.api.ts` + endpoints — `listAdvanceRequestsForMyReports(wsId)` + `verifyAdvanceRequest(wsId, id, note?)`.
- Reporting-review surface: a card in `components/dashboard/salary/MySalary.tsx` (worker salary page) gated on `can('salary','review_advance','self')` showing the caller's reports' requests with a Verify button + note. (MySalary is the natural self-scoped home; reuse `useMyPermissions().can`.)
- Tests for the api + the review card core.

---

## Task 1: BE enum + schema fields

- [ ] Add `REVIEW_ADVANCE = 'review_advance'` to ModuleAction (comment: reporting person reviews/verifies direct reports' advance requests; reportsTo-filtered; toggled in PermissionGrid salary row).
- [ ] Add `verifiedBy/verifiedAt/verifyNote` to the schema (additive, nullable; no migration).
- [ ] Commit `feat(salary): REVIEW_ADVANCE action + verify fields on advance request`.

## Task 2: BE service + endpoints (TDD)

- [ ] Write failing tests (advance-review.vitest.ts, @nestjs/mongoose mock pattern; verify the service constructor needs the TeamMember model — it already injects `teamMemberModel`):
  - `listForMyReports`: returns only requests whose member's `reportsTo` == reviewer's teamMemberId. (Mock teamMemberModel.find({reportsTo}) -> [memberIds]; advanceRequestModel.find({teamMemberId in memberIds}).)
  - `verifyRequest`: sets verifiedBy/At/note; THROWS if the target request's member is NOT a direct report of the reviewer; THROWS if reviewer is verifying their OWN request (SoD).
- [ ] Implement both. `listForMyReports`: `const reportIds = await teamMemberModel.find({ workspaceId, reportsTo: reviewerTeamMemberId }).distinct('_id')`; then advanceRequestModel.find({ workspaceId, teamMemberId: { $in: reportIds } }).sort(createdAt desc).lean(). `verifyRequest`: load request; assert request.teamMemberId !== reviewerTeamMemberId (SoD); assert the request's member.reportsTo == reviewerTeamMemberId; set verifiedBy=userId, verifiedAt=now, verifyNote=note; save; audit `advance_request.verified`.
- [ ] Controller: add the two routes before the parameterised owner GET. Resolve `ctx = await callerScope.resolve(wsId, req.user.sub)`; require `ctx.teamMemberId` (else Forbidden). `VerifyAdvanceRequestDto` for the PATCH body.
- [ ] Run per-file tests + `npm run build`. Commit `feat(salary): reportsTo-filtered advance review + verify endpoints`.

## Task 3: Role seeder (only if Manager preset exists)

- [ ] `grep -n "Manager\|manager" src/modules/rbac/role-seeder.constants.ts`. If a Manager/Supervisor preset role exists, add `grant(AppModule.SALARY, [ModuleAction.REVIEW_ADVANCE], 'self')` to it + update its vitest. If NO manager preset, SKIP (owner grants per-member via PermissionGrid) and note it. Either way the permission is grantable in the UI (Task 4).
- [ ] Commit if changed `feat(rbac): grant review_advance to manager preset`.

## Task 4: Web — permission row + api + review card

- [ ] `PermissionGrid.tsx`: add `{ name: 'review_advance', scoped: true }` to the salary row (with a comment mirroring request_advance). This makes it owner-toggleable in Grant App Access.
- [ ] `types/index.ts`: add verifiedBy/At/Note to AdvanceSalaryRequest; `VerifyAdvancePayload { note?: string }`.
- [ ] endpoints + `salary.api.ts`: `advanceRequestsForMyReports(wsId)` => `.../advance-requests/for-my-reports`; `verifyAdvanceRequest(wsId,id)` => PATCH `.../:id/verify`. Client wrappers `listAdvanceRequestsForMyReports`, `verifyAdvanceRequest`.
- [ ] `MySalary.tsx`: add a "Team advance requests" card, rendered only when `useMyPermissions().can('salary','review_advance','self')`. Lists reports' requests (member name, period, requested amount, status, verified badge) with a Verify button + optional note (small Modal/Popconfirm). On verify -> `verifyAdvanceRequest` -> refresh. AntD v6; `t(key,{defaultValue})`.
- [ ] TDD: api wrapper test + a test that the review card calls verifyAdvanceRequest. eslint 0. Commit `feat(salary-web): reporting-person advance review + verify` (+ a separate commit for the PermissionGrid row if cleaner).

## Final verification

- [ ] BE per-file tests + build green; web scoped tests + eslint green.
- [ ] Smoke: set member B.reportsTo = manager A; grant A `review_advance`; B requests an advance; A sees it under "Team advance requests" and can Verify with a note; A canNOT verify A's own; owner still sees + approves everything regardless of A's verify.

## Self-review

- Coverage: §6.3 reporting-person review = Tasks 1-4. NOT a new RBAC scope (reportsTo-filtered endpoint + REVIEW_ADVANCE action mirrors REQUEST_ADVANCE). Verify is advisory (no gate on owner approve). Eligibility caps = Phase 3b.
- Risk: medium (new permission + endpoints). Mitigated by mirroring the proven REQUEST_ADVANCE pattern + SoD test + reportsTo-membership assertion in verify.
