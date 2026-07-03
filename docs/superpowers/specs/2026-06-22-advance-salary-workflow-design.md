# Advance Salary Workflow — Design Spec

Date: 2026-06-22
Status: DRAFT — awaiting owner review before planning
Scope: `crewroster-backend` (salary, team/RBAC, payroll-config) + `crewroster-web` (worker/owner/manager UI)

This is the 0-interest **salary advance** (recovered from future pay). It is and stays
DISTINCT from the interest-bearing **EmployerLoan** tool. No change to loans here.

---

## 1. Goal

Make the advance-salary feature match the real SME / textile-karkhana cash workflow:

1. Owner sets WHEN employees may request (a single day, e.g. 21, or a window, e.g. 21–23).
2. Employees submit their own requested amount inside that window.
3. The employee's **reporting person** can see & verify the request (permission-gated, advisory).
4. The **owner always sees everything** and is never blocked by the manager.
5. Owner enters the **fundable budget** for the cycle; the system splits it **pro-rata by
   requested amount**, **rounds to clean figures**, and lets the owner hand-edit anyone.
6. On the fixed **payout day** (e.g. 25), the responsible person distributes and records
   **how** each was paid (UPI / bank / cash / split) + proof + **who handed it over**.
7. The advance and its monthly recovery are visible in the **Salary module** so nothing is
   recalculated at distribution time.

Anti-fraud is a first-class requirement: a manager must not be able to inflate a worker's
ask or skim cash, so the workflow enforces maker-checker separation + a who-disbursed audit.

---

## 2. What ALREADY exists (reuse, do NOT rebuild)

| Capability                                                                                                                                               | Where                                                                 | Notes                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Request-window engine (`any_day` / `window` / `fixed_day` + legacy `advanceRequestDay`)                                                                  | `payroll-config.schema.ts:114-160`, `advance-request-window.util.ts`  | Engine complete; UI only exposes the legacy single day                         |
| Request lifecycle `pending→approved→paid` (+ rejected/cancelled), once-per-month unique index                                                            | `advance-salary-request.schema.ts`, `.service.ts`                     | Need to SPLIT approve from pay (see §5)                                        |
| 0% recovery: `SalaryAdjustment(category=advance_recovery)` + multi-installment `AdvanceRecoveryPlan`, 50% deduction cap + min-wage floor + carry-forward | `salary.service.ts` (createAdvanceRecoveryPlan / two-pass compliance) | Reuse as-is                                                                    |
| Split payment + audit fields (`splitLines`, `recordedBy`, `paidBy`, `referenceNo`, `proofUrls`, `paymentDate`, bank/upi detail)                          | `payment.schema.ts:22-136`                                            | Backend supports it; advance UI never collected it                             |
| Loan **approval-chain** model (`ApprovalStep[]`, `approvalChainDefault`)                                                                                 | `employer-loan.schema.ts`, `loan.service.ts`                          | Reference pattern for routing; advances will use the lighter `reportsTo` route |
| `TeamMember.reportsTo` (self-FK)                                                                                                                         | `team-member.schema.ts:139-140`                                       | EXISTS but dormant — this is the manager graph we activate                     |
| Worker notifications on decision                                                                                                                         | `advance-salary-request.service.ts` (notifyWorker)                    | Extend to notify reviewer + on disburse                                        |
| SoD guard: owner can't approve own advance                                                                                                               | `salary.service.ts` (assertNotSelfSalaryEdit)                         | Extend to reviewers/managers                                                   |

Net: the **engine is ~70% built**; the gaps are workflow, allocation, disbursement UX, routing, and salary-module surfacing.

---

## 3. Decisions locked (owner, 2026-06-22)

1. **Two-step pay** — approve/allocate during the window; distribute on the payout day.
2. **Reporting-person review is advisory + permission-gated**, NOT a blocking gate. Owner
   sees all and acts without waiting. Manager is also an employee (can request; cannot
   self-review).
3. **Budget pool** — owner enters fundable amount → pro-rata by requested amount → **round
   DOWN to nearest ₹100** (total never exceeds pool; leftover unused) → owner can hand-edit
   any individual → final per-person amount reflects on the employee's account.
4. Eligibility caps (max % of salary, max/year, min tenure) — shipped **owner-configurable,
   OFF by default**.
5. Unfunded / zeroed requests **roll to the next window** (not auto-rejected).

---

## 4. New status lifecycle

```
                         (reporting person may VERIFY — advisory flag, no state change)
requested ──▶ allocated ──▶ disbursed ──▶ recovering ──▶ recovered
   │             │
   │             └──▶ queued (not funded this cycle → next window)
   └──▶ rejected / cancelled
```

- `requested` (pending): employee submitted inside the window.
- `verified` flag (NOT a state): reporting person reviewed (optional/advisory).
- `allocated` (NEW): owner set the funded amount for this cycle; awaiting payout day. (This
  is today's `approved` but **without** auto-disbursing.)
- `queued` (NEW): valid request not funded this cycle; auto-carried to the next window.
- `disbursed` (today's `paid`): paid on payout day, method + proof + who recorded.
- `recovering` / `recovered`: existing recovery-plan progress (derived, not necessarily a
  stored state).

Backward-compat: existing `paid` rows map to `disbursed`; the once-per-active-period unique
index keeps its semantics.

---

## 5. Data-model changes (LOGICAL — flagged for explicit approval)

### 5.1 PayrollConfig.disbursementRules (additions)

- `advanceRequestPolicy` — already in schema; **expose in settings UI** (mode + window/fixedDay).
- `advancePayoutDay` (NEW): day-of-month the advance batch is distributed (e.g. 25), 1–28.
  Separate from `salaryDate`.

### 5.2 New `PayrollConfig.advanceConfig` sub-doc (all optional, OFF by default)

- `roundToNearest` (default 100) — allocation rounding granularity.
- `maxPercentOfNet` (null = off) — cap an advance at X% of the member's net.
- `maxPerYear` (null = off), `minTenureMonths` (null = off), `oneOpenAtATime` (default true,
  already effectively enforced by the unique index).

### 5.3 AdvanceSalaryRequest (additions)

- `verifiedBy` / `verifiedAt` / `verifyNote` — reporting-person advisory review.
- `allocatedAmount` — owner-funded amount for the cycle (distinct from `requestedAmount` and
  the eventual disbursed amount).
- `cycleKey` (e.g. `2026-06`) + optional `batchId` — group a month's requests for allocation.
- `disbursedBy` — who actually handed over the money (may differ from approver). (Payment
  already holds `recordedBy` / `paidBy`; we surface a request-level pointer for audit.)
- `status` enum gains `allocated` + `queued` (keep `paid` as alias of `disbursed` for compat).

### 5.4 New concept: cycle allocation

A per-workspace, per-month allocation run holding `{ fundablePool, allocations[], status }`.
Implement as a lightweight `AdvanceDisbursementBatch` schema OR a computed view over the
month's requests — to be decided in the plan (leaning: a thin batch doc for auditability).

### 5.5 RBAC / Team permissions (additions)

- New permission **`salary.advance.review` (scope = team)** — reporting person can view/verify
  their direct reports' advance requests. Exposed in the **Team module permission UI**.
- Owner/finance keep **`salary.advance.allocate` / approve / disburse (scope = all)** (today's
  `salary.edit@all`). Split into named advance actions for clarity.
- Existing **`salary.request_advance@self`** unchanged (managers use it for their own asks).
- **SoD:** a member can never review/allocate/disburse their OWN request; a reviewer who is
  also the requester is skipped (routes up to owner).
- This introduces a **team scope** ("my direct reports") to RBAC, which today only has
  self/all — flagged as a logical addition.

---

## 6. Workflow by surface

### 6.1 Owner — Payroll Settings (web)

Configure: request window (day or range), payout day, rounding, optional eligibility caps.
Replaces the single legacy "advance request cut-off day" field.

### 6.2 Employee — request (web/app)

- See the window state up-front ("Advance window: 21–23" / "Opens on the 21st", not an error
  on submit).
- Submit own amount (existing). Show their own request + status + any reviewer note.

### 6.3 Reporting person — review (web) [permission-gated]

- List of their direct reports' requests for the cycle; can mark **verified** + add a note
  (advisory). Cannot see amounts beyond their team; cannot act on their own.

### 6.4 Owner — allocation queue (web) [NEW]

- Month batch view: every request, requested amount, running total, reviewer verify flag.
- Enter fundable pool → auto pro-rata + round-down → editable per-row → leftover/queued shown.
- Confirm allocation → each request becomes `allocated`; employees see their funded amount.

### 6.5 Owner / assigned person — disbursement on payout day (web)

- Open the cycle batch; for each allocated request record method (cash/bank/UPI/cheque/split),
  reference/proof, and who disbursed. Reuses Payment `splitLines` + audit. Triggers recovery
  plan (existing).

### 6.6 Salary module surfacing

- Owner payroll/distribution view: per employee show advance disbursed + recovery due this
  month. Worker MySalary already shows recovery; keep + ensure owner side mirrors it.

---

## 7. Cases & edge cases covered

- Window open/closed; "opens on X" messaging.
- One open advance per member per month (existing unique index).
- Owner approves less than requested; pool shortfall → pro-rata + round-down + queue rest.
- Rounding leftover (pool partially unused) — acceptable per owner.
- Manual per-row override re-balances the remaining pool.
- Manager requests own advance → routes to _their_ manager / owner; cannot self-review/approve.
- Disburser ≠ approver — both stamped (anti-fraud).
- Recovery auto-capped at 50% of wages + min-wage floor, stretched across months if needed.
- Manager on leave → owner disburses directly (assignable).
- Member with no app account → notification skipped (existing).
- Cancelled/rejected request may be re-submitted (excluded from unique index).
- Advance kept fully separate from EmployerLoan (category + module).

## 8. Anti-fraud controls

- Employee enters their own request (never manager-entered); owner sees all.
- Allocated ≤ requested; SoD across review / allocate / disburse.
- Who-disbursed + method + reference/proof captured per payout.
- Audit-log each transition (request, verify, allocate, disburse) — extend existing AuditService.

---

## 9. Proposed phasing (all phases ship — order only)

- **Phase 1 — Window + two-step pay + disbursement capture:** settings UI for window + payout
  day; worker sees window; split `approved`→`allocated`/`disbursed`; payout-day UI with
  method/proof/who-disbursed; owner salary-module surfacing.
- **Phase 2 — Budget allocation:** fundable pool, pro-rata + round-down, manual override,
  queue-to-next-window, per-employee reflection.
- **Phase 3 — Reporting-person review + RBAC:** `reportsTo`-based review, new team
  permission + team scope, SoD for managers, optional eligibility caps.

---

## 10. Open items for the plan (not blocking this spec)

- Batch as a stored doc vs computed view (lean: thin stored doc).
- Exact migration for new statuses + `advanceConfig` defaults (additive, backfill-safe).
- Whether disbursement may be split across days or must be one payout event.
- i18n keys across en / gu / gu-en / hi-en for all new surfaces.
