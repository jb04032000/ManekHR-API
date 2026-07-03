# Advance Two-Step Approve → Payout-Day Disburse (Phase 1b) — Implementation Plan

> **For agentic workers:** Use superpowers:test-driven-development for every task. Steps use `- [ ]`.

**Goal:** Split the advance flow into (1) APPROVE the amount during the request window and (2) DISBURSE on the payout day, capturing how it was paid (cash / bank / UPI / cheque / split), reference/proof, and who handed it over. Today "approve" instantly disburses with no method/proof capture.

**Architecture:** The pieces exist. `advanceSalaryRequestService.approve()` already does pending→approved + sets `approvedAmount` (no payment). `payApprovedAdvance` already pays an approved request. We (a) rewire the `approve` endpoint to approve-ONLY, (b) MOVE recovery-plan creation + ADD split/proof/disbursedBy capture into the disburse (`payApprovedAdvance`) step, and (c) give the owner queue a two-step UI. `approved` is the "allocated, awaiting payout" state (no new status needed). `approveAndDisburseAdvanceRequest` stays for back-compat but the HTTP `approve` route no longer calls it.

**Tech Stack:** NestJS + Mongoose + class-validator; Next.js + AntD v6; vitest both sides.

**Spec:** `docs/superpowers/specs/2026-06-22-advance-salary-workflow-design.md` §5,§6.4,§6.5. Reuses split logic from `recordPayment` (salary.service.ts ~7031) and recovery-plan logic from `approveAndDisburseAdvanceRequest` (~6727).

**Conventions:** no whole-suite vitest / whole-project tsc (OOM) — per-file only; `npm run build` (SWC) for BE compile sanity; AntD v6 only; audit every write; comments on changed blocks (no em-dash); commit per task path-scoped, never `git add -A`, never stage concurrent WIP (esp. `app/messages/*`).

---

## File Structure

**Backend**

- Modify `src/modules/salary/dto/advance-salary-request.dto.ts` — `ApproveAdvanceRequestDto` keeps amount+note (recovery terms become OPTIONAL there, used only by the legacy combined path); extend `PayAdvanceRequestDto` with: `installmentCount?`, `installmentAmount?`, `startMonth?`, `startYear?`, `overrideCompliance?`, `overrideReason?`, `splitLines?` (reuse the same split-line shape `recordPayment` accepts), `proofUrls?`, `disbursedByName?`.
- Modify `src/modules/salary/advance-salary-request.controller.ts` — `approve` route calls a new approve-ONLY service path (no disburse); `pay` route already calls `payApprovedAdvance` (now the full disburse).
- Modify `src/modules/salary/salary.service.ts` — `payApprovedAdvance`: add split/proof/disbursedBy to the Payment, add the split feature-gate (mirror `recordPayment`), and CREATE the recovery (multi-installment plan OR single deduction — lift the block from `approveAndDisburseAdvanceRequest` 6727-6772), audit `advance_request.disbursed`, notify worker. Add `advancePayoutDay` read-through (informational).
- Modify `src/modules/salary/schemas/payroll-config.schema.ts` + `src/modules/salary/dto/update-disbursement-rules.dto.ts` — add `advancePayoutDay` (1-28, default null) to disbursementRules.
- Tests: `src/modules/salary/__tests__/advance-disburse.two-step.vitest.ts`, extend `update-disbursement-rules.dto.vitest.ts`.

**Web**

- Modify `types/index.ts` — extend `PayAdvanceRequestPayload` (new) / approve payload; `DisbursementRules.advancePayoutDay?`.
- Modify `lib/api/modules/salary.api.ts` + `lib/actions/salary.actions.ts` — `payAdvanceRequest(wsId, id, payload)` wrapper (PATCH `:id/pay`); `approveAdvanceRequest` becomes amount+note only.
- Modify `app/dashboard/salary/components/salary/AdvanceApprovalQueue.tsx` — Approve modal = amount + note only; add a Disburse action on `approved` rows opening a new `AdvanceDisburseDrawer`.
- Create `app/dashboard/salary/components/salary/AdvanceDisburseDrawer.tsx` — method (cash/bank/upi/cheque/split) + split lines + reference + proof upload + who-disbursed + recovery installment config (reuse `AdvanceInstallmentConfigurator`).
- Modify `DisbursementRulesPanel.tsx` — add `advancePayoutDay` InputNumber.
- Tests for the disburse drawer + queue two-step.

---

## Task 1: BE — advancePayoutDay config (small, do first)

- [ ] Write failing test in `update-disbursement-rules.dto.vitest.ts`: DTO accepts `advancePayoutDay: 25`; rejects 0 and 40.
- [ ] Run → fail.
- [ ] Add to `payroll-config.schema.ts` disbursementRules sub-doc: `advancePayoutDay: { type: Number, default: null, min: 1, max: 28 }` + the TS type. Add to `UpdateDisbursementRulesDto`: `@IsOptional() @IsInt() @Min(1) @Max(28) advancePayoutDay?: number;`. Persist in `updateDisbursementRules` (`$set['disbursementRules.advancePayoutDay']`).
- [ ] Run → pass. Commit `feat(salary): advancePayoutDay config field`.

## Task 2: BE — approve becomes approve-only

- [ ] Write failing test (`advance-disburse.two-step.vitest.ts`): calling the approve path on a pending request sets status `approved` + `approvedAmount` and creates NO Payment (assert paymentModel.save not called / no payment doc). Use the @nestjs/mongoose decorator-mock pattern.
- [ ] Run → fail (today the approve route disburses).
- [ ] In `advance-salary-request.controller.ts`, change the `approve` handler to call `advanceSalaryRequestService.approve(workspaceId, requestId, req.user.sub, { approvedAmount, reviewNote })` (the existing approve-only service method) instead of `salaryService.approveAndDisburseAdvanceRequest`. Keep `ApproveAdvanceRequestDto` accepting the recovery-term fields as OPTIONAL (the legacy combined method + tests still use them) but the approve route ignores them.
- [ ] Run → pass. Commit `feat(salary): approve advance no longer auto-disburses (two-step)`.

## Task 3: BE — disburse step does split + proof + who + recovery

- [ ] Write failing tests (`advance-disburse.two-step.vitest.ts`):
  - `payApprovedAdvance` with `installmentCount: 3` creates an AdvanceRecoveryPlan (assert `createAdvanceRecoveryPlan` called) — today it does NOT.
  - with `splitLines: [{method:'bank_transfer',amount:...},{method:'cash',amount:...}]` saves them on the Payment and enforces the `splitPayments` feature gate.
  - with `disbursedByName`/`proofUrls`/`referenceNo` persists them.
  - status flips approved→paid.
- [ ] Run → fail.
- [ ] In `payApprovedAdvance`: after creating the base Payment, (a) if `paymentMode==='split' || splitLines?.length`, assert `splitPayments` feature + attach `splitLines` to paymentData (mirror `recordPayment` ~7031-7036); (b) persist `proofUrls`, `disbursedByName` (store on Payment.paidBy or a dedicated field — reuse `paidBy` for the name + add `proofUrls`); (c) LIFT the recovery block from `approveAndDisburseAdvanceRequest` (lines 6727-6772): multi-installment → `createAdvanceRecoveryPlan`, else `createAdvanceRecoveryDeduction`, using `dto.installmentCount/installmentAmount/startMonth/startYear/overrideCompliance`, defaulting startMonth to request.month+1; (d) add the `advance_request.disbursed` audit + PostHog + `notifyAdvanceDisbursed` (lift from the combined method). Extend `PayAdvanceRequestDto` with the new optional fields first.
- [ ] Run → pass. `npm run build`. Commit `feat(salary): disburse advance captures split/proof/who + creates recovery plan`.

## Task 4: Web — types + API

- [ ] Extend `types/index.ts`: `PayAdvanceRequestPayload` { paymentMode?, paymentDate?, referenceNo?, note?, paidBy?, coaAccountId?, installmentCount?, installmentAmount?, startMonth?, startYear?, overrideCompliance?, overrideReason?, splitLines?: SalarySplitLine[], proofUrls?: string[], disbursedByName? }; `DisbursementRules.advancePayoutDay?`.
- [ ] `lib/actions/salary.actions.ts` + `lib/api/modules/salary.api.ts`: add `payAdvanceRequest(wsId, id, payload)` → PATCH `E.payAdvanceRequest(wsId,id)` (endpoint `:id/pay`); make `approveAdvanceRequest` send only `{ approvedAmount, reviewNote }`.
- [ ] eslint touched files. Commit `feat(salary-web): pay-advance types + client`.

## Task 5: Web — AdvanceDisburseDrawer + two-step queue

- [ ] TDD a test for `AdvanceDisburseDrawer`: choosing split with two lines + a who-disbursed name calls `payAdvanceRequest` with `splitLines` summing to the approved amount and `disbursedByName`.
- [ ] Build `AdvanceDisburseDrawer.tsx` (AntD v6 Drawer): payment method select; when split, dynamic split-line rows (method + amount, validated to sum to approved amount); reference; proof upload (reuse the existing upload pattern / `uploadService` `salary-proof` category if present, else referenceNo only); who-disbursed text; recovery config via existing `AdvanceInstallmentConfigurator`. Submit → `payAdvanceRequest`.
- [ ] In `AdvanceApprovalQueue.tsx`: Approve modal now only amount + note (move the `AdvanceInstallmentConfigurator` out of approve). Add a "Disburse" button on rows with status `approved` that opens `AdvanceDisburseDrawer`. Show `pending` vs `approved` vs `paid` filters.
- [ ] Run tests → pass. eslint. Commit `feat(salary-web): two-step approve + disburse drawer`.

## Task 6: Web — payout-day setting + i18n defaults

- [ ] Add `advancePayoutDay` InputNumber to `DisbursementRulesPanel` (1-28, optional). Use `t(key,{defaultValue})` for all new strings (no message-file edits).
- [ ] eslint. Commit `feat(salary-web): advance payout-day setting`.

## Final verification

- [ ] BE per-file vitest green (Tasks 1-3) + `npm run build`.
- [ ] Web scoped vitest green + eslint 0 on touched files.
- [ ] Smoke: approve a request (stays "approved", no payment) → disburse it with a bank+cash split + who-disbursed → request goes "paid", recovery plan appears, salary module shows recovery next month.

## Self-review

- Coverage: §6.4 approve-only = Task 2; §6.5 disburse capture + recovery = Task 3,5; payout day = Task 1,6.
- Risk: Task 3 is payroll-critical (lifts recovery logic). The two-step tests assert recovery IS created on disburse (regression guard) and that approve does NOT pay. `approveAndDisburseAdvanceRequest` is left intact for back-compat.
- Type consistency: `PayAdvanceRequestDto` (BE) ↔ `PayAdvanceRequestPayload` (web) field names match.
