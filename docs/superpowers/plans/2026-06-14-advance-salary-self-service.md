# Worker self-service salary advance (Option A) — plan & research

Status: IN PROGRESS — owner approved Option A + the logical changes (2026-06-14).
Date: 2026-06-14. Scope chosen by owner: Option A.
Repos touched: crewroster-backend (logical changes), crewroster-web (mostly assembly), crewroster-app (fast-follow, see §7).

### Build progress (backend; build + focused vitest green, full 16GB typecheck deferred to commit/CI)

- [x] Step 1 — IDOR security fix: create binds to caller's own member; `teamMemberId` removed from `CreateAdvanceRequestDto`. (advance-salary-request.controller.vitest.ts: 2 tests)
- [x] Step 2 — `ModuleAction.REQUEST_ADVANCE` added; create + /mine re-gated to it; seeded onto `DEFAULT_WORKER_ROLE` (self). (role-seeder.constants.vitest.ts: +3 tests; full RBAC suite green)
- [x] Step 3 — core loop: `SalaryService.approveAndDisburseAdvanceRequest` (approve -> isAdvance Payment w/ `advanceRequestId` -> `createAdvanceRecoveryPlan` or single deduction -> `markPaid`); idempotent; ledger non-blocking; audit + PostHog. Controller approve route now calls it. (salary.service.advance-disburse.vitest.ts: 3 tests)
- [x] Step 4 — `ApproveAdvanceRequestDto` gains installmentCount/installmentAmount/startMonth/startYear/paymentMode/coaAccountId/overrideCompliance/overrideReason. `Payment.advanceRequestId` schema field added.
- [x] Step 5 — `advanceRequestPolicy` (any_day|window|fixed_day) on disbursementRules (new=any_day on insert; existing read undefined -> fixed_day fallback via lean guard); pure `isAdvanceRequestWindowOpen` util + createRequest guard rewrite; migrations 0038 (Worker request_advance grant backfill) + 0039 (PayrollConfig policy stamp -> fixed_day). (advance-request-window.util.vitest.ts: 5 tests; backfill-worker-request-advance-grant.vitest.ts: 2 tests)
- [x] Step 6 — worker notifications on approve/reject. `AdvanceSalaryRequestService` gains `NotificationsService` + `TeamMember` model (token already in SalaryModule scope; NotificationsModule already imported). `reject()` notifies the worker (best-effort, swallowed); new public `notifyAdvanceDisbursed` helper notifies on disburse and is called from `SalaryService.approveAndDisburseAdvanceRequest` after markPaid (SalaryService constructor untouched). Recipient resolved member->`linkedUserId` (kiosk-only members skipped); link `/dashboard/salary`; English copy mirrors leave-notification.service. (advance-salary-request.service.notify.vitest.ts: 5 tests; salary.service.advance-disburse.vitest.ts: +2 tests). **FnF `AdvanceRecoveryPlan.remainingAmount` reconciliation = fast-follow, still flagged (§6.8).**
- [x] Step 7 — web UI. PermissionGrid `salary.request_advance (self)` toggle + `rbac.action.request_advance` (x4 locales). Drawer RELOCATED to `components/dashboard/salary/AdvanceRequestDrawer.tsx` (worker bundle) and SIMPLIFIED — dropped the day-gate UI mirror because a self-scoped worker cannot read PayrollConfig (GET payroll-config is `salary view:all`); server is authoritative (ADVANCE_REQUEST_DAY_CLOSED surfaces on submit). **DEVIATION from §5.1** (no client-side request-day mirror; correct given the per-worker permission model + new any_day default). MySalary: "Request an advance" CTA in the advances card (gated `<Can salary request_advance self>` AND `advancePayments.enabled`) + new `MyAdvanceRequests` list (GET /mine, live status, loading/empty/error+retry). Approval queue reworked: `AdvanceInstallmentConfigurator` + `previewAdvanceSchedule` in the approve modal (default 3-month split), compliance-breach override (checkbox+reason, OK disabled until resolved), member-name resolution (listTeam), scroll-body per modal binding; `ApproveAdvanceRequestPayload` extended (installmentCount/Amount, startMonth/Year, overrideCompliance/Reason). Dedicated route `/dashboard/salary/advance-requests` + `loading.tsx` + `nav-permissions` route gate (`salary edit:all`) + `SalaryWorkspaceNav` item (gated edit:all + advancePayments). Dead inline queue + dead per-member drawer + state/imports removed from RunPayrollPage. All 4 locales (gu/gu-en/hi-en added via agents). **Verified: web tsc 0 errors in changed files (1 pre-existing PaySlipsSection/PayDrawer error is owner WIP, untouched), eslint 0 errors, locale-parity 10/10.** Pending-count nav badge deliberately omitted (avoids a per-nav fetch on every salary page) — flag for owner if wanted.
  - **Adversarial review (6-dimension workflow):** 2 raised, 1 confirmed + FIXED. Fix: approve-modal "compliance freshness" gate — `complianceReady` state in AdvanceApprovalQueue blocks the Approve button until a FRESH compliance preview lands for the current amount/plan (dirty-on-input effect + `setComplianceReady(r != null)` on the configurator's result). Closes the stale-clean window (amount raised into a 50%-cap breach for ~400ms before breaches recompute → un-overridden approve sent → raw error toast) AND the preview-error window (a failed preview no longer silently clears the breach gate). Backend already fail-closes, so this was a UX defect, not a compliance bypass. Parent-only change (configurator untouched → PayDrawer unaffected). Re-verified: tsc + eslint clean.
- [x] Step 8 (PARTIAL) — mobile self-service advance flow shipped (crewroster-app). New: `features/salary/types/advance-request.types.ts`, `api/advance-request.api.ts` (self endpoints), `components/request-advance-sheet.tsx` (amount→paise→POST, IST month/year, paise≥1 guard), `screens/my-advances-screen.tsx` (own request list + status chips + loading/empty/error/refresh + no-workspace state), route `app/salary/my-advances.tsx`, and a "My Advances" tile in the More menu. SAFE: only self endpoints (no roster exposure), backend-authorized. Units: advance amounts are PAISE (rupeesToPaise/formatINRFromPaise), unlike rupee salary records. Hardcoded English (matches the mobile salary module convention — it has no i18n). Adversarial review fixes applied (IST timezone, paise≥1, no-workspace state). Verified: mobile tsc 0 errors in changed files, eslint 0 errors. UNCOMMITTED.

  **Worker-mode foundation (next session) — DONE 2026-06-14 (partial):** client RBAC mirror of the web — new `services/permissions/permissions.{types,api}.ts` (GET /workspaces/:wsId/me/permissions), `stores/permissions-store.ts` (per-workspace cache + ensure + `permissionsMatch` mirroring the web/BE), `hooks/use-my-permissions.ts` (`can(module,action,scope)`/isOwner/teamMemberId/loading, fail-closed while loading). **Role-aware Salary TAB** — `app/(tabs)/salary.tsx` now branches like the web salary route: `selfScoped = !isOwner && !can('salary','view','all')` → worker sees `MyAdvancesScreen`, else the admin console (admin data never fetched for a worker; spinner while perms load). Advance CTA gated on `can('salary','request_advance','self')`. **Adversarial RBAC review (3-dim workflow): 7 raised, 4 confirmed + ALL FIXED:** (1) workspace-switch staleness → invalidate RBAC centrally in `workspace-store.setWorkspace` ONLY when the id changes (dynamic import avoids the static cycle; skips same-id metadata updates); (2) RBAC cache survived logout → invalidate centrally in `auth-store.clearSession` (covers all teardown paths: more-menu, profile, 401/403 interceptor — dynamic import for cycle-safety); (3) a failed permissions fetch was a permanent dead-end → hook exposes `retry()` (manual, no auto-loop); (4) on a permissions ERROR `salary.tsx` silently downgraded an admin to the worker screen → now shows an explicit error + retry (doesn't fall through to selfScoped). Re-verified: mobile tsc 0 errors, eslint 0 errors.

  **Role-aware tab SET — DONE 2026-06-14 (needs device test).** `app/(tabs)/_layout.tsx` rewritten: declares EVERY (tabs) route explicitly (index, my-salary[new], bills, attendance, team, salary, more, settings, notifications) so Expo Router never auto-adds a hidden route as a stray tab; per-role visibility via `href` (null=route navigable but no tab button). Worker → Home·My Salary·More; manager/owner → Home·Bills·Attendance·Team·Salary·More; settings+notifications never tabs. New `app/(tabs)/my-salary.tsx` renders MyAdvancesScreen (worker surface); salary.tsx branch kept for deep-links. `permsLoading`→render null (matches prior config-load); `permsError`→admin set (no manager lockout). Focused code review (Code Reviewer agent): logic all correct, ONE runtime defect found + FIXED — added `/my-salary` to `ROOT_ROUTES` in `hooks/use-back-exit.ts` (worker tab needed double-tap-to-exit). mobile tsc 0 / eslint 0. **MUST device-test on an emulator (worker + owner login): correct tab set, no ghost/duplicate tabs, initial route OK, deep-links to hidden routes still work. I cannot run the app.** The mock `services/tabs/tab-config.mock.ts` + DEFAULT_TAB_CONFIGS are now unused by \_layout (left in place; not removed).

  **Worker "My Salary" screen rounded out — DONE 2026-06-14.** `my-advances-screen.tsx` (still named MyAdvancesScreen, kept to avoid import churn; docstring updated) expanded from advances-only to a full worker salary surface: **payslip history** (own salary ledger) + **outstanding-advance recovery schedule** (per-advance installments with status chips) above the existing request flow. New typed API `getMyLedger` + `getMyOutstandingAdvances` (self endpoints salary/history|advances/:memberId, salary view:self own-id, backend-enforced via assertSalarySelfReadAllowed) + types (LedgerRecord/OutstandingAdvancesResponse). **UNITS (critical, verified against web formatCurrencyFull which does NOT /100): ledger + outstanding-advance amounts are RUPEES → formatINR; advance-REQUEST amounts are paise → formatINRFromPaise.** Best-effort allSettled (failures swallowed; request flow unaffected); teamMemberId from useMyPermissions (early-returns null until perms resolve, then re-fetches). Focused code review (Code Reviewer agent): units/self-access/lifecycle all correct, ONE hardening item FIXED (`getMyOutstandingAdvances` now returns a defaulted shape so `.advances.map` can't crash on a null/partial 2xx). mobile tsc 0 / eslint 0. Needs device test with the rest.

---

## 1. Problem & chosen scope

Admins can already give an advance and an interest-free amount recovered in monthly
installments. Workers can **see** their outstanding advance + installment schedule on their
own salary screen, but **cannot request** money from their own account.

A self-service request lifecycle was started but left half-built and disconnected:

- `POST /salary/advance-requests` (self), `GET /advance-requests/mine` (self), owner
  `approve`/`reject` all exist.
- **Broken loop:** `markPaid` (approved → paid) has **zero callers**. An approved request
  never becomes a real disbursement, and the auto-recovery deduction (matches only
  `status='paid'`) never fires for this path — and it recovers the full amount in one month,
  not installments.
- The real interest-free **multi-installment recovery engine** (`Payment.isAdvance` +
  `AdvanceRecoveryPlan`) is complete but driven only by the admin add-advance payment, **not
  connected** to requests.
- **Security hole:** `createRequest` trusts `dto.teamMemberId` from the body (IDOR — a
  self-scoped worker could request on another member's behalf).
- No dedicated "request advance" permission; it reuses generic `salary view (self)`. Seeded
  Worker/Karigar role gets **zero** salary grants.
- Web request drawer `AdvanceRequestDrawer` is built but mounted only on the admin payroll
  page and never opened (dead). `GET /mine` has no UI consumer.
- Mobile app is entirely admin-facing — no worker "my salary" or request flow at all.

**Option A:** worker self-service "Request an advance", always interest-free, recovered in
small monthly installments the **approver** sets at approval time. Connect approve → disburse →
the existing recovery engine. Add a dedicated, separately-grantable "request advance"
permission surfaced in Grant App Access. Show live status + schedule to the worker. Fix the
security hole. Make request-timing a workspace policy. Keep the formal EmployerLoan tool
admin-only.

---

## 2. Research synthesis (competitors + India statutory)

Surveyed: Keka, RazorpayX Payroll, GreytHR, Zoho People/Payroll, Deel, Rippling, BambooHR,
PagarBook (closest to Gujarat textile reality).

Key takeaways adopted:

- **Two-tier model is the consensus:** small interest-free _advance_ (self-service, this
  build) kept distinct from a formal interest-bearing _loan_ (admin-only, already exists). Do
  not blur them.
- **Best-in-class flow:** request with reason → single manager/HR approval → immediate
  disbursement record → automatic installment recovery netted in payroll (RazorpayX/GreytHR).
  Maps exactly onto our existing `AdvanceRecoveryPlan` engine — connect, don't rebuild.
- **Approver sets the installment plan at approval time**, not the worker. Worker requests an
  amount; approver decides how it's recovered.
- **Always interest-free** for the self-service advance. Interest stays exclusive to the
  EmployerLoan tool. Interest-free also sidesteps perquisite-tax for typical small amounts.
- **Cap as % of net pay**, ideally the lower of (a) a % of monthly net and (b) earned-to-date,
  so we never advance unearned wages.
- **Recovery starts the month after disbursement** (grace cycle, avoids same-month double hit).
- **Transparency** (Deel/BambooHR) is the modern differentiator: show outstanding, schedule,
  next-payday deduction, live request status, and a "you can request up to ₹X" helper.
- **Leaver:** outstanding balance pulled into Full & Final and netted from final pay.

### India statutory (binding)

- **Payment of Wages Act 1936 §7(3):** total deductions in a wage period ≤ **50%** of wages
  (75% only with co-op-society payments). Advance recovery is an "other case" → **50% cap**.
  Per-installment guardrail must enforce this.
- **§7(2)(f) + §12:** recovery of advances is an expressly permitted deduction; advancing
  _unearned_ wages is the regulated/riskier path → cap at lower of %-net and earned-to-date.
- **Interest-free loan perquisite (IT Rule 3(7)(i)):** an interest-free employer advance is a
  taxable perquisite only above the exemption threshold — **₹20,000 until 31-Mar-2026, ₹2,00,000
  from 01-Apr-2026**. Typical small textile advances are below this (silent no-op). Build a
  date-driven threshold check so a large advance is correctly flagged. Keep the threshold a
  config value.

---

## 3. Recommended defaults (ship these; all workspace-configurable)

| Knob                      | Default                                                                         | Notes                                                 |
| ------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Who can request           | Worker with new `request_advance` (self) **AND** workspace self-service enabled | AND-gate, like self-punch                             |
| Amount cap                | Lower of **50% of monthly net** and **earned-to-date**                          | 50% hard ceiling = PoWA-safe; % configurable 25–80    |
| Minimum amount            | none                                                                            | configurable                                          |
| Interest                  | **0%, hardcoded**                                                               | interest-bearing = EmployerLoan only                  |
| Recovery                  | equal monthly installments, set by approver; default split ≈ `ceil(amount/3)`   | starts **month after** disbursement                   |
| Max tenor                 | **6 months**                                                                    | configurable 1–12; long tenors → use the loan tool    |
| Per-installment guardrail | no month's advance-recovery > 50% of that month's net                           | forces longer tenor if breached                       |
| Frequency / stacking      | block a new request while one is outstanding; ≤ 1 active advance                | optional 1/month frequency cap                        |
| Tenure gate               | 90 days (probation-style)                                                       | configurable                                          |
| Request timing            | **anytime** (new workspaces)                                                    | existing workspaces keep their fixed-day on migration |
| Approval                  | single-step by a `salary edit (all)` holder                                     |                                                       |
| Perquisite guard          | flag if aggregate interest-free outstanding > threshold (₹20k→₹2L date-driven)  | config value                                          |
| Skip/pause + early payoff | reuse engine pause/resume + early-payoff; skip extends tenor, never waives      |                                                       |
| Leaver                    | outstanding auto-surfaced in Full & Final                                       |                                                       |

---

## 4. Backend design (crewroster-backend)

Reuse, don't rebuild. The recovery engine, ledger posting, and outstanding reads all already
key off `Payment(isAdvance)` + `AdvanceRecoveryPlan` + `advance_recovery` adjustments.

1. **Core loop — connect approve → disburse → recovery.** Add a thin public
   `SalaryService.disburseApprovedAdvanceRequest(workspaceId, requestId, userId)` that:
   loads the request (assert `approved`, `approvedAmount>0`); idempotency short-circuit on
   `request.paymentId`; builds `Payment(isAdvance, advanceForMonth/Year, amount, ...)`; calls
   the existing `salaryLedgerPostingService.postAdvancePayment(...)` (non-blocking try/catch);
   calls the existing private `createAdvanceRecoveryPlan(...)` with the approval's installment
   config (or `createAdvanceRecoveryDeduction()` when count===1); calls the previously-dead
   `markPaid()` to flip approved→paid + stamp `paymentId`; audits + PostHog. Make `approve()`
   call this atomically (one approve = approve+disburse) so there's no second button to forget.
   Avoid the `SalaryService ↔ AdvanceSalaryRequestService` cycle with `forwardRef` (or invert
   so SalaryService orchestrates). `getOutstandingAdvances` + FnF then pick it up with no extra
   change.
2. **Approval DTO** gains `installmentCount` / `installmentAmount` (exactly-one-of, max 24),
   optional `startMonth/startYear`, `paymentMode`, `coaAccountId`,
   `overrideCompliance/overrideReason`. **No interest field, ever.**
3. **Security fix:** `createRequest` resolves the caller's own `teamMemberId` via
   `CallerScopeService` (like `listMine` does) and ignores the body id; remove `teamMemberId`
   from `CreateAdvanceRequestDto`. Highest priority — ship even if other pieces slip.
4. **Dedicated permission:** add `ModuleAction.REQUEST_ADVANCE = 'request_advance'`, re-gate
   create + listMine from `SALARY VIEW self` to `SALARY REQUEST_ADVANCE self`. Mirrors
   `APPLY_LEAVE`. Owner queue/approve/reject stay `SALARY EDIT all`.
5. **Seed:** give `DEFAULT_WORKER_ROLE` a `SALARY [REQUEST_ADVANCE] self` grant. Inert unless
   subscription `advance_payments` + workspace policy both allow → zero effect on free tier.
   Existing workspaces need a re-seed/backfill.
6. **Timing policy:** generalize `disbursementRules.advanceRequestDay` into
   `advanceRequestPolicy { mode: any_day|window|fixed_day, fixedDay, windowStartDay,
windowEndDay }`. Keep `advanceRequestDay` for backward-compat; migrate existing workspaces
   to `fixed_day` from it; new workspaces default `any_day`. Rewrite the create-time guard.
7. **Notifications** to the worker on approve/reject (`NotificationsService.createNotification`,
   already in SalaryModule). **Leaver:** FnF already consumes `advance_recovery` adjustments;
   **documented gap** — FnF should also read `AdvanceRecoveryPlan.remainingAmount` so
   not-yet-generated future installments aren't under-counted at exit (treat as fast-follow).

Effort: ~2.5–3.5 days BE + colocated `*.vitest.ts` (disburse idempotency, plan creation,
markPaid transition, IDOR self-bind, policy guard modes, exactly-one-of validation).

---

## 5. Web design (crewroster-web)

All building blocks exist; this is mostly assembly.

1. **"Request an advance" CTA** on the worker's `MySalary.tsx` (in the advances Card),
   gated `<Can module="salary" action="request_advance" scope="self">` and AND-gated on the
   `advance_payments` subscription feature. Reuse the existing `AdvanceRequestDrawer`
   (relocate it to `components/dashboard/salary/` so the worker bundle doesn't import the admin
   payroll tree). Load PayrollConfig on this surface for the request-day mirror.
2. **"My requests" status list** — new `MyAdvanceRequests.tsx` consuming the currently-unused
   `listMyAdvanceRequests` (`GET /mine`): period, requested/approved amount, status Tag,
   approver note. Refetch on submit.
3. **Schedule view** — no new component; the existing outstanding + `InstallmentScheduleTable`
   card is the post-approval view once disburse runs.
4. **Approval queue** — add the existing `AdvanceInstallmentConfigurator` + `previewAdvanceSchedule`
   into the approve modal so the approver sets the tenor; promote the queue to a dedicated route
   `/dashboard/salary/advance-requests` (+ `loading.tsx`) gated `salary edit (all)`; add a
   nav/CTA + pending Badge. Remove the dead per-member request trigger + inline queue Collapse
   from the payroll page.
5. **Grant App Access** — add `{ name: 'request_advance', scoped: true }` to the salary row in
   `PermissionGrid.tsx` + `rbac.action.request_advance` label (4 locales).

All pieces: loading/empty/error states, 4-locale parity, a11y. Most are non-logical; the
permission token + approve-with-installments are the logical dependencies (must land BE-side
first or the FE gate/control is inert).

---

## 6. Logical changes requiring owner approval (the gate)

1. **Approve now also disburses** — fixes the broken loop (creates Payment + recovery plan,
   calls the dead `markPaid`). One approve = approve + disburse.
2. **New `Payment.advanceRequestId` field** linking a disbursed advance back to its request
   (idempotency + cleaner ledger lookup).
3. **Approve endpoint gains installment params** (`installmentCount`/`installmentAmount`,
   `startMonth/Year`, payment mode, compliance override). Interest-free always.
4. **Request contract change / security fix** — `teamMemberId` removed from the create body;
   bound to the caller's own member (closes the IDOR).
5. **New permission `salary.request_advance`** (separately grantable in Grant App Access).
6. **Seeded Worker/Karigar role** gains `request_advance (self)` — needs backfill for existing
   workspaces. Double-gated, so no free-tier impact.
7. **New `advanceRequestPolicy` config** (anytime / window / fixed-day) generalizing the
   single request-day; existing workspaces migrated to fixed-day.
8. **(Fast-follow, logical) — DONE 2026-06-14.** FnF nets a leaver's TRUE, FRESH outstanding advance.
   `FnfService.getOutstandingAdvances` rewritten: outstanding = sum over active|paused plans of
   (`totalAmount − sum(elapsed active installments)`) + sum of non-plan (legacy lump) advance_recovery deductions
   whose target month is current-or-future. **Adversarial review caught that the first cut (sum `remainingAmount`)
   was WRONG**: `remainingAmount` is only refreshed by `refreshPlanProgress` on plan EDITS, never on month
   roll-over, so it is stale-high and would over-charge the leaver; AND legacy lumps stay `status:'active'` forever
   after recovery, so an un-month-filtered legacy sum double-deducts an already-recovered lump. Fix recomputes
   `totalAmount − elapsed` LIVE (same rule as refreshPlanProgress, includes un-schedulable residual) and
   month-filters legacy lumps; plan-linked ids excluded from the legacy pass (no double-count). Mirrors the
   worker-facing `SalaryService.getOutstandingAdvances`/`fetchOutstandingBalanceInternal` so F&F nets what the
   worker sees; kept self-contained (no SalaryService dep → no cycle). Also fixed a pre-existing TS2300 duplicate
   `bonusClawbackRecoverable` key in `computeFnfTotals`'s return type (masked by SWC; would fail real tsc).
   Test-first: `fnf.service.outstanding-advances.vitest.ts` (4 tests, RED-then-GREEN) + 18 existing FnF compliance
   tests green; `npm run build` clean. No module change. **Known limitation (pre-existing, not introduced): the
   workspace overview `getAdvancesLoansBonus` still reads the stale `remainingAmount` — separate fix.** UNCOMMITTED.

---

## 7. Mobile (crewroster-app) — recommend fast-follow, not in this pass

Mobile has **no worker/self mode at all**: fixed admin tabs, no per-member RBAC, no "my
salary" screen. A standalone request sheet would leak the whole roster. Doing it properly
requires building a worker-mode foundation first (caller role/scope hook, role-aware
navigation, a "My Salary" self screen), then the request sheet + "my requests" list (which
consume the same self endpoints, no new logical changes). Recommend: **ship web first, mobile
as an immediate fast-follow** once the BE permission/loop changes land.

---

## 8. Build sequence

1. BE security fix (IDOR) — independent, highest priority.
2. BE permission enum + controller re-gate + seed + backfill + `/me/permissions` + registry.
3. BE core loop (disburse method + approve wiring + `advanceRequestId` FK + idempotency) + tests.
4. BE approval DTO installment params + compliance surfacing + tests.
5. BE timing policy schema + guard + migration + tests.
6. BE notifications; flag FnF reconciliation as fast-follow.
7. Web: PermissionGrid toggle; MySalary CTA + drawer relocation; MyAdvanceRequests list;
   approval-queue installment configurator + dedicated route; nav/CTA. 4 locales, loading.tsx.
8. Verify end to end (request → approve+disburse → schedule shows → recovery deducts → status).
9. Mobile fast-follow (separate pass).

## 9. Open risks

- Service cycle (`forwardRef`), disburse idempotency (FK + paymentId short-circuit), compliance
  breach during disburse (block vs override), existing-workspace backfill for the new grant +
  policy, and not silently flipping live workspaces to "anytime". See agent risk notes.
