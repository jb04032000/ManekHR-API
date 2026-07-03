# Advance Budget-Pool Allocation (Phase 2) — Implementation Plan

> Use superpowers:test-driven-development. Steps `- [ ]`.

**Goal:** When total advance requests exceed what the company can fund, the owner enters a fundable amount and the system splits it **pro-rata by each person's requested amount, rounded down to a clean figure (₹100)**, editable per person; then bulk-approves. Unfunded requests stay pending (roll to the next window).

**Architecture:** WEB-ONLY. No backend change — allocation is a pure client util; "approve all" loops the EXISTING per-request approve endpoint (`approveAdvanceRequest`, already two-step = sets approvedAmount, status pending→approved, no disburse). Disbursement is the separate Phase 1b step. Round-to-nearest is a ₹100 constant (configurable is a future nicety).

**Tech Stack:** Next.js + AntD v6 + vitest. All new strings via `t(key,{defaultValue})` (no message-file edits — concurrent WIP).

---

## File Structure (web only)

- Create `features/salary/utils/allocateAdvancePool.ts` — pure allocation function.
- Create `features/salary/utils/allocateAdvancePool.vitest.ts` — unit tests.
- Modify `app/dashboard/salary/components/salary/AdvanceApprovalQueue.tsx` — budget-allocation panel on the `pending` tab (pool input + Distribute + editable per-row allocations + running total vs pool + "Approve all").
- (Optional) Create `app/dashboard/salary/components/salary/AdvanceAllocationPanel.tsx` if the queue file grows too large — keep the queue focused.

---

## Task 1: Pure allocation util (TDD)

**Files:** create `features/salary/utils/allocateAdvancePool.ts` + `.vitest.ts`

Contract (all amounts in PAISE, integers):

```ts
export interface AllocInput {
  id: string;
  requestedPaise: number;
}
export interface AllocResult {
  id: string;
  allocatedPaise: number;
}
export function allocateAdvancePool(
  poolPaise: number,
  requests: AllocInput[],
  roundToPaise = 10000, // ₹100
): { allocations: AllocResult[]; totalAllocatedPaise: number; leftoverPaise: number };
```

Rules (encode as tests FIRST):

- Empty requests → empty allocations, leftover = pool.
- Pool ≥ total requested → everyone gets their FULL requestedPaise (no rounding-down below the request); leftover = pool − totalRequested.
- Pool < total requested → each `alloc_i = floor( (pool * requested_i / totalRequested) / roundTo ) * roundTo`, then `alloc_i = min(alloc_i, roundDownToRoundTo(requested_i))` is NOT applied when pool≥total; under-pool just floor+cap at requested. Never allocate more than requested. Never negative.
- Sum(alloc) ≤ pool always (rounding down guarantees it); `leftoverPaise = pool − sum(alloc)` (≥0).
- `totalAllocatedPaise = sum(alloc)`.
- Deterministic; no Math.random / Date.
  Example test: pool ₹3,00,000, requests [₹2,00,000, ₹3,00,000] (total ₹5,00,000), roundTo ₹100 → raw [120000,180000] → rounded [₹1,20,000, ₹1,80,000] sum ₹3,00,000 leftover 0. Another with non-clean ratios asserting round-DOWN + leftover.

- [ ] Write the failing tests (the cases above) → run → fail.
- [ ] Implement the pure function → run → pass.
- [ ] eslint. Commit `feat(salary-web): advance budget pro-rata allocation util`.

## Task 2: Allocation panel in the queue

**Files:** `AdvanceApprovalQueue.tsx` (+ optional `AdvanceAllocationPanel.tsx`)

- [ ] On the `pending` filter tab, add an allocation panel: shows all pending requests for the selected cycle (month/year) with requested amounts + a total; an InputNumber for "Fundable amount (₹)"; a **Distribute** button that runs `allocateAdvancePool(pool, pendingRequests, 10000)` and fills a per-row editable "Allocate ₹" InputNumber; a live running total of allocations vs the pool (warn if total > pool); each row editable (manual override, no auto-rebalance); rows allocated ₹0 are labelled "rolls to next window".
- [ ] An **"Approve allocated"** button: for each row with allocated > 0, call the existing `approveAdvanceRequest(wsId, id, { approvedAmount: allocatedPaise })` (loop; show progress; refresh on done). Rows at ₹0 stay pending.
- [ ] Keep AntD v6. New strings via `t(key,{defaultValue})`.
- [ ] TDD a component/integration test where feasible (e.g. Distribute fills rows summing ≤ pool; Approve-allocated calls approveAdvanceRequest once per funded row). If full-queue render is too heavy to test, extract the allocation-panel logic so its core is unit-testable and test that.
- [ ] eslint + scoped vitest (`--no-file-parallelism`). Commit `feat(salary-web): owner budget-pool allocation in advance queue`.

## Final verification

- [ ] util tests + panel test green; eslint 0 on touched files.
- [ ] Smoke: 3 pending requests totalling more than the pool → enter pool → Distribute → pro-rata rounded amounts, editable → Approve allocated → those go "approved" (ready to disburse via Phase 1b), ₹0 rows stay pending.

## Self-review

- Coverage: §6.4 pool + pro-rata + round-down + manual edit + queue-leftover = Tasks 1,2. No BE change (reuses approve). Disburse is Phase 1b. Eligibility caps = Phase 3.
- Risk: low (pure util + FE loop over an existing, tested endpoint). No payroll-engine change.
