# Attendance Anomalies Remediation Implementation Plan

> ✅ **STATUS: COMPLETE (1 task voided) — verified 2026-05-18.** Implemented in a prior session; the `- [ ]` checkboxes below were never ticked but the work is done — `anomaly_detection` registry + gating, controller `@RequireSubscription`, detection-correctness fixes, dedup index, OTel/PostHog/Sentry observability, web `<FeatureGate>` + RBAC guard + page UX + i18n.
>
> ⚠️ **Task 4 Step 1 (remove `binding_conflict` + `locked_payroll_push` as "stub rule types") is VOID — premise wrong.** Both are LIVE anomaly types emitted by `attendance-ingest.service.ts:286,377` and integration-tested in `attendance-ingest/__tests__/ingest-integration.vitest.ts`. They are system-emitted anomalies, not user-configurable rules — correct by design (`anomaly-rule.schema.ts` excludes them, `anomaly.schema.ts` records them). **Do NOT remove them** (owner decision 2026-05-18).
>
> One genuine gap closed 2026-05-18: `toggleRule` 400 unit test added (`src/modules/anomalies/__tests__/anomalies-controller.vitest.ts`, 4 cases). 50/50 anomalies vitest pass.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Repo convention override:** Per `crewroster-backend/CLAUDE.md` and `crewroster-web` rules, the **assistant runs ZERO git commands** — the owner stages + commits. Every task therefore terminates at a **Verify** step, not a commit. Group related changes so the owner can commit per task.

**Goal:** Remediate every issue from the Attendance Anomalies audit — close the subscription-gating gap, fix detection-correctness bugs, clean dead code, and bring the web surface to the same UX/i18n bar as its sibling attendance features.

**Architecture:** Anomaly detection becomes a first-class gated attendance sub-feature (`anomaly_detection`) registered in both the backend `module-features.registry.ts` and web `feature-access.registry.ts`, enforced by `@RequireSubscription` (BE) + `<FeatureGate>` (web) — identical to its siblings `overtime_analytics` / `compliance_report` / `absence_patterns` / `attendance_muster`. A boot-time migration backfills the key into existing subscriptions. Detection-correctness fixes (timezone, dedup, recipient permission) land in the `anomalies` module services. The web page gets gating, an RBAC guard, a human-readable context column, and full i18n.

**Tech Stack:** NestJS + Mongoose (backend), Next.js 16 + antd v6 + next-intl (web), Vitest (backend tests).

**Spec source:** The Attendance Anomalies audit delivered in conversation on 2026-05-18. Locked decisions: (1) gate `anomaly_detection` with the **same per-tier access values as its siblings**; (2) **remove** the two stub rule types `binding_conflict` + `locked_payroll_push`.

**Canonical sub-feature key:** `anomaly_detection` (snake_case, mirrors `overtime_analytics`). This exact string MUST be identical in the backend registry, the web registry, the `@RequireSubscription` decorator, and the `<FeatureGate subFeature=...>` prop — a key mismatch is the registry-drift class of bug.

---

## File Structure

**Backend (`crewroster-backend/`)**

- `src/common/constants/module-features.registry.ts` — MODIFY: register `anomaly_detection` under the `attendance` module + add it to `TIER_SUBFEATURE_DEFAULTS`.
- `src/modules/subscriptions/attendance-plan-migration.service.ts` — MODIFY: backfill `anomaly_detection` into existing subscriptions' `appliedEntitlements`.
- `src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts` — MODIFY: cover the new key.
- `src/modules/anomalies/anomalies.controller.ts` — MODIFY: `@RequireSubscription` + `@Throttle` on every route; `toggleRule` returns HTTP 400 on bad input.
- `src/modules/anomalies/anomaly-detection.service.ts` — MODIFY: `detectOffShift` timezone fix; `detectRapidDup` once-per-burst dedup; OTel/Sentry on `detectOnEvent`.
- `src/modules/anomalies/anomalies.service.ts` — MODIFY: OTel spans + PostHog events on `record`/`acknowledge`; Sentry on catches; add `rapid_dup` to dedupe handling.
- `src/modules/anomalies/anomaly-notify.service.ts` — MODIFY: recipient permission `manage_devices` → `manage_anomalies`; guard null-`contextKey` email path.
- `src/modules/anomalies/schemas/anomaly.schema.ts` — MODIFY: drop `binding_conflict` + `locked_payroll_push` from the ruleType enum; add compound dedup index.
- `src/modules/anomalies/schemas/anomaly-rule.schema.ts` — MODIFY: confirm enum already excludes the two stubs (no change expected — verify).
- `src/modules/anomalies/anomaly-notify.service.ts` (`RULE_TITLES`) — MODIFY: drop the two stub titles.
- `src/modules/anomalies/anomalies.controller.ts` (`ALL_RULE_TYPES`) — MODIFY: confirm it already excludes the stubs (verify).
- `src/modules/anomalies/__tests__/*.vitest.ts` — MODIFY: add tests for timezone, rapid_dup dedup, toggleRule 400, notify permission.

**Web (`crewroster-web/`)**

- `lib/constants/feature-access.registry.ts` — MODIFY: register `anomaly_detection` under the `attendance` module.
- `app/dashboard/attendance/anomalies/page.tsx` — MODIFY: `<FeatureGate>` wrap, RBAC guard, context-column formatter, page wrapper width, `t()` for hardcoded strings, dead-code removal, bulk-ack `finally`, pagination-total fix, severity icon.
- `app/dashboard/attendance/anomalies/loading.tsx` — CREATE: skeleton matching sibling routes.
- `app/messages/en.json`, `gu.json`, `gu-en.json`, `hi-en.json` — MODIFY: translate the `attendance.anomalies` block + add new keys.

---

## Task 1: Backend — register `anomaly_detection` in the feature registry

**Files:**

- Modify: `src/common/constants/module-features.registry.ts`
- Modify: `src/modules/subscriptions/attendance-plan-migration.service.ts`
- Test: `src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts`

- [ ] **Step 1: Read the sibling rows.** Open `module-features.registry.ts`. Locate the `attendance` module entry and its sub-feature list (currently ends with `attendance_muster`, `overtime_analytics`, `compliance_report`, `absence_patterns`, `defaulter_alerts`). Record the exact object shape of one sibling (e.g. `overtime_analytics`) — `key`, `label`, `description`, and any `category`/order field.

- [ ] **Step 2: Add the `anomaly_detection` sub-feature.** Append a new entry to the `attendance` module's sub-feature array, copying the sibling shape:
  - `key: 'anomaly_detection'`
  - `label: 'Anomaly Detection'`
  - `description: 'Flag suspicious attendance events — unknown devices, rapid duplicates, missed streaks, off-shift punches, time-travel.'`
  - same `category`/ordering convention as siblings.

- [ ] **Step 3: Add tier defaults.** Locate `TIER_SUBFEATURE_DEFAULTS`. Find the row(s) for `overtime_analytics` / `compliance_report` / `absence_patterns` (the analytics siblings). Add an `anomaly_detection` entry to **every tier** with the **exact same `FeatureAccessLevel` value each sibling has for that tier** (locked/limited/full). Anomaly detection is a peer analytics surface — replicate the sibling matrix row verbatim.

- [ ] **Step 4: Extend the migration.** Open `attendance-plan-migration.service.ts`. It already backfills `attendance_muster` / `overtime_analytics` / etc. into existing subscriptions' `appliedEntitlements.moduleAccess[].subFeatures[]`. Add `anomaly_detection` to the set of keys it backfills, using the same per-tier access resolution + the same dedupe-safe write the service already uses for siblings (do **not** reintroduce the `$addToSet`-of-object duplicate bug — follow the existing per-key presence check).

- [ ] **Step 5: Write/extend tests.** In `attendance-plan-migration.service.vitest.ts`, add a test asserting a subscription missing `anomaly_detection` gets it backfilled at the tier-correct access level, and a subscription already having it is left unchanged (idempotent).

- [ ] **Step 6: Run tests.** Run: `cd crewroster-backend && npx vitest run src/modules/subscriptions/__tests__/attendance-plan-migration.service.vitest.ts`
      Expected: PASS, including the new cases.

- [ ] **Step 7: Verify.** Confirm `anomaly_detection` appears in the registry with sibling-matched tier defaults and the migration covers it. Backend `tsc` OOMs on this machine — rely on tests + targeted `npx eslint` on the touched files.

---

## Task 2: Backend — enforce subscription + throttler on the anomalies controller

**Files:**

- Modify: `src/modules/anomalies/anomalies.controller.ts`

- [ ] **Step 1: Read the controller.** Note every route, its current `@RequirePermissions(AppModule.ATTENDANCE, ModuleAction.MANAGE_ANOMALIES)` decorator, and how a sibling attendance controller applies `@RequireSubscription(...)` + `@Throttle(...)` (read `attendance.controller.ts` for the exact decorator import + argument shape used for `overtime_analytics`).

- [ ] **Step 2: Add `@RequireSubscription`.** On every anomalies route (list, count, acknowledge, bulk-acknowledge, toggle-rule, list-rules — all of them), add `@RequireSubscription` for the `attendance` module + `anomaly_detection` sub-feature, using the identical decorator form `attendance.controller.ts` uses for its gated routes.

- [ ] **Step 3: Add `@Throttle`.** Add the same throttler tier the sibling attendance controller routes use (read-heavy routes get the read tier; mutations get the write tier — mirror `attendance.controller.ts`).

- [ ] **Step 4: Verify.** `npx eslint` the controller. Confirm via reading that no route is left without `@RequireSubscription` + `@Throttle` + the existing `@RequirePermissions`.

---

## Task 3: Backend — detection-correctness fixes

**Files:**

- Modify: `src/modules/anomalies/anomaly-detection.service.ts`
- Modify: `src/modules/anomalies/anomaly-notify.service.ts`
- Modify: `src/modules/anomalies/anomalies.controller.ts`
- Test: `src/modules/anomalies/__tests__/anomaly-detection.vitest.ts`, `anomaly-service.vitest.ts`

- [ ] **Step 1: Investigate shift timezone.** `detectOffShift` (`anomaly-detection.service.ts:73-81`) computes `eventMin` via `getUTCHours()/getUTCMinutes()` but compares against `shift.startTime`/`endTime` `'HH:mm'` strings. Determine the timezone basis: check the `Workspace` schema for a timezone field, and check how the punch `timestamp` and shift `startTime` are stored (UTC vs workspace-local). The audit's hypothesis: shift times are workspace-local (IST), punch timestamp is a UTC `Date` → 5.5h skew.

- [ ] **Step 2: Write the failing test.** In `anomaly-detection.vitest.ts`, add a test: a punch at 09:30 **workspace-local** time, with a shift `09:00–18:00`, must NOT be off-shift. Construct the punch `Date` as the UTC instant equivalent to 09:30 in the workspace timezone (e.g. IST → 04:00 UTC). With the current UTC-based code this asserts `false` but the code returns `true` → test fails.

- [ ] **Step 3: Fix `detectOffShift`.** Convert the event timestamp to workspace-local minutes before comparing — the workspace timezone must be threaded into the detection path (add a `timeZone` field to `ShiftSnapshot`, or pass it as a parameter, sourced from the workspace). Apply the **same conversion** in `detectOnEvent`'s `off_shift_punch` block (`anomaly-detection.service.ts:196`) where `eventMin` is recomputed for the `deltaMinutes` context. Do not leave the two computations divergent.

- [ ] **Step 4: Fix `rapid_dup` multi-fire.** `detectRapidDup` returns `true` for the 5th event **and every event after** in the same window → multiple anomaly rows per burst. Change it to fire **once per burst**: when the threshold is first crossed for a key, set a "fired" marker in the LRU entry; suppress further `true` until the window empties. Adjust the LRU value type if needed (e.g. `{ times: number[]; fired: boolean }`).

- [ ] **Step 5: Test `rapid_dup` dedup.** Add a test: 8 events within the 10s window produce exactly **one** `true` from `detectRapidDup` (on event 5), `false` for events 6–8.

- [ ] **Step 6: Fix notify recipient permission.** In `anomaly-notify.service.ts`, `resolveAdminRecipients` filters recipients by the `attendance.manage_devices` permission — change it to `attendance.manage_anomalies` (the permission that actually governs the anomaly surface). Use the same `ModuleAction.MANAGE_ANOMALIES` enum the controller uses.

- [ ] **Step 7: Fix null-`contextKey` email path.** In `anomaly-notify.service.ts`, the 24h email-dedup `findOne` is skipped entirely when `anomaly.contextKey` is null → unbounded email send. All current rules set a `contextKey`; harden anyway: when `contextKey` is null, fall back to a dedup key derived from `{wsId, ruleType, teamMemberId, createdAt-day}` so a missing key cannot cause email spam.

- [ ] **Step 8: Fix `toggleRule` status code.** In `anomalies.controller.ts`, `toggleRule` returns `{ error: 'invalid_rule_type' }` with HTTP 200 on a bad `ruleType`. Throw `BadRequestException('invalid_rule_type')` instead so the contract is a proper 4xx.

- [ ] **Step 9: Test the fixes.** Run: `cd crewroster-backend && npx vitest run src/modules/anomalies/__tests__/`
      Expected: PASS, including the new off-shift, rapid_dup, and (if reachable in unit scope) toggleRule cases.

- [ ] **Step 10: Verify.** `npx eslint` the three touched files.

---

## Task 4: Backend — remove stub rules, add dedup index, observability

**Files:**

- Modify: `src/modules/anomalies/schemas/anomaly.schema.ts`
- Modify: `src/modules/anomalies/schemas/anomaly-rule.schema.ts` (verify only)
- Modify: `src/modules/anomalies/anomaly-notify.service.ts` (`RULE_TITLES`)
- Modify: `src/modules/anomalies/anomalies.controller.ts` (`ALL_RULE_TYPES` — verify)
- Modify: `src/modules/anomalies/anomalies.service.ts`
- Modify: `src/modules/anomalies/anomaly-detection.service.ts`

- [ ] **Step 1: Remove stub rule types.** In `anomaly.schema.ts`, delete `binding_conflict` and `locked_payroll_push` from the `ruleType` enum. Grep the whole `anomalies/` module for both strings and remove every reference: `RULE_TITLES` entries in `anomaly-notify.service.ts`, any type unions, any switch arms. Confirm `anomaly-rule.schema.ts`'s enum and the controller's `ALL_RULE_TYPES` already exclude them (audit says they do — verify, no change expected).

- [ ] **Step 2: Add the dedup index.** In `anomaly.schema.ts`, add a compound index `{ wsId: 1, ruleType: 1, contextKey: 1, acknowledged: 1 }` — this covers the dedup `findOne` in `anomalies.service.ts` (`{ wsId, ruleType, contextKey, acknowledged: false }`) which currently has no covering index.

- [ ] **Step 3: Add observability.** Per `crewroster-backend/CLAUDE.md`: wrap `AnomaliesService.record()` and `acknowledge()` and `AnomalyDetectionService.detectOnEvent()` in `tracer.startActiveSpan('anomalies.<verbNoun>', ...)` with `workspaceId`/`result` attributes (no raw PII). Emit PostHog write events `anomalies.anomaly_recorded` and `anomalies.anomaly_acknowledged` (distinct-id = userId where available, props include `workspaceId` + `ruleType`). Wrap the `record()` and `detectOnEvent()` error catches with `Sentry.captureException(err, { tags: { module: 'anomalies', op: '<op>' } })` in addition to the existing `Logger.warn`.

- [ ] **Step 4: Run tests.** Run: `cd crewroster-backend && npx vitest run src/modules/anomalies/__tests__/`
      Expected: PASS (removing the stub enum values must not break any test — if a test referenced them, that test was asserting dead behavior; update it).

- [ ] **Step 5: Verify.** `npx eslint` the touched files. Grep the `anomalies/` module once more for `binding_conflict`/`locked_payroll_push` — expect zero hits.

---

## Task 5: Web — register `anomaly_detection` + gate the page

**Files:**

- Modify: `crewroster-web/lib/constants/feature-access.registry.ts`
- Modify: `crewroster-web/app/dashboard/attendance/anomalies/page.tsx`

- [ ] **Step 1: Register the sub-feature.** In `feature-access.registry.ts`, find the `attendance` module's sub-feature list (ends with `attendance_muster`, `overtime_analytics`, `compliance_report`, `absence_patterns`, `defaulter_alerts`). Add `anomaly_detection` with the same entry shape a sibling uses (`key`, `label`, `description`). The `key` MUST be exactly `'anomaly_detection'` to match the backend registry (Task 1).

- [ ] **Step 2: Gate the page.** In `anomalies/page.tsx`, wrap the page body with `<FeatureGate module="attendance" subFeature="anomaly_detection" as="h1">` — copy the exact usage from `components/dashboard/attendance/reports/OvertimePanel.tsx` (`<FeatureGate module="attendance" subFeature="overtime_analytics" as="h1">`).

- [ ] **Step 3: Add the RBAC guard.** The page renders fully for any direct-URL visitor regardless of permission. Add a `useMyPermissions()` check: if permissions are resolved and the user lacks `can('attendance', 'MANAGE_ANOMALIES')` (and is not owner), render the standard permission-denied surface instead of the page (mirror how another manager-only attendance page handles this — e.g. the pattern in `AttendanceWorkspaceNav.tsx` which already gates on `MANAGE_ANOMALIES`, applied here as a full-page guard). While permissions are unresolved, render the loading skeleton — never flash the page to an unauthorized user.

- [ ] **Step 4: Verify.** `cd crewroster-web && npx tsc --noEmit` (web tsc works on this machine) — expect clean. Browser-check: on a plan where `anomaly_detection` is locked, the page shows the upgrade prompt; on a plan with access, the feed renders.

---

## Task 6: Web — anomalies page functionality + UX

**Files:**

- Modify: `crewroster-web/app/dashboard/attendance/anomalies/page.tsx`
- Create: `crewroster-web/app/dashboard/attendance/anomalies/loading.tsx`

- [ ] **Step 1: Human-readable context column.** The `Context` cell renders raw `{key: value}` pairs including raw ISO timestamps (`missingDays: 2026-05-16T00:00:00.000Z,...`) and raw object keys. Replace the renderer: format any ISO-date value as `DD MMM` (via the project's `dayjs` usage), join lists with `·`, and map raw keys to readable labels through a `t()`-backed label map (`streakLength` → "Streak length", `missingDays` → "Missing days", `deltaMinutes` → "Off by (min)", `eventCount` → "Events", `windowSeconds` → "Window (s)", `shiftStart`/`shiftEnd`/`eventTimestamp` → readable). Keep it generic — unknown keys fall back to a title-cased label.

- [ ] **Step 2: Page wrapper width.** Change the page root from `<div className="space-y-5">` to the sibling-consistent `<div className="mx-auto max-w-7xl p-6 space-y-6">` (matches `reports/page.tsx`). Keep the attendance layout's outer `space-y-6` in mind — no double padding.

- [ ] **Step 3: i18n the hardcoded strings.** The mount-path error handlers use raw `'Failed to load anomalies'` / `'Failed to load rules'`. Route them through `t('attendance.anomalies.toast.failLoad')` / `t('...failLoadRules')` (keys already exist — the dead `useCallback`s already use them).

- [ ] **Step 4: Remove dead code.** Delete the unused `loadRules` `useCallback` (the rules effect re-implements it inline). Change every `catch (e: any)` to `catch (e: unknown)` with the `instanceof Error` narrowing already used by the `acknowledge` handler.

- [ ] **Step 5: Fix bulk-ack partial failure.** The bulk-acknowledge handler calls `load()` only inside the `try` block, so a partial `Promise.all` failure leaves the list stale. Move the `load()` refetch to a `finally` block so the list always reconciles after a bulk operation.

- [ ] **Step 6: Fix pagination total under type filter.** `typeFilter` is applied client-side over one fetched page, but the pagination `total` stays the unfiltered server count. When a type filter is active, drive the pagination `total` from the filtered row count (`visibleRows.length`) so the control is not misleading. (Server-side filtering is out of scope — the count fix is the required correctness fix.)

- [ ] **Step 7: Severity icon.** The `med` severity uses an info-circle icon that reads as low-salience. Give `med` a warning-style icon (e.g. `ExclamationCircleOutlined`) distinct from `high` (`WarningOutlined`) and `low` (check). Keep the existing color tokens.

- [ ] **Step 8: Add `loading.tsx`.** Create `anomalies/loading.tsx` with a skeleton matching the sibling routes (`overtime`/`compliance` `loading.tsx`) so client navigation shows a skeleton, not a blank slot.

- [ ] **Step 9: Verify.** `cd crewroster-web && npx tsc --noEmit` — clean. Browser-check: context column readable, page constrained on wide viewport, bulk-ack reconciles after partial failure, `med` severity icon distinct.

---

## Task 7: Web — i18n for the anomalies block

**Files:**

- Modify: `crewroster-web/app/messages/en.json`, `gu.json`, `gu-en.json`, `hi-en.json`

- [ ] **Step 1: Add new keys (en).** In `en.json`, under `attendance.anomalies`, add any keys introduced by Task 6: the context-label map (`ctxLabel.streakLength`, `ctxLabel.missingDays`, `ctxLabel.deltaMinutes`, `ctxLabel.eventCount`, `ctxLabel.windowSeconds`, `ctxLabel.shiftStart`, `ctxLabel.shiftEnd`, `ctxLabel.eventTimestamp`, `ctxLabel.serverTime`) and any permission-denied copy from Task 5's RBAC guard. Use clear English values.

- [ ] **Step 2: Translate `gu.json` (Gujarati).** The entire `attendance.anomalies` block in `gu.json` is currently an English copy. Translate every string to Gujarati script — page title, explainers, feed/rules titles, column headers, rule names, toast messages, the new context labels. Match the translation quality of the already-translated `settingsPage` block in the same file.

- [ ] **Step 3: Translate `gu-en.json` (romanized Gujarati).** Translate the `attendance.anomalies` block to Gujlish (romanized Gujarati) — same convention as the `settingsPage` block (`subtitle` romanized, short data labels may stay English). Column headers / rule names follow the existing romanization style.

- [ ] **Step 4: Translate `hi-en.json` (romanized Hindi).** Same for Hinglish — match the `settingsPage` block's style in `hi-en.json`.

- [ ] **Step 5: Verify.** All four files must stay valid JSON (`cd crewroster-web && npx tsc --noEmit` will not catch JSON — load each page locale in the browser or run a JSON parse). Confirm key parity: every key under `attendance.anomalies` in `en.json` exists in all three other files.

---

## Self-Review

**Spec coverage** — every audit finding mapped to a task:

- 🔴 No subscription gating → Task 1 (registry+migration), Task 2 (BE enforce), Task 5 (web registry+gate). ✓
- 🔴 Raw context column → Task 6 Step 1. ✓
- 🔴 `off_shift_punch` timezone → Task 3 Steps 1-3. ✓
- 🔴 No RBAC guard on page → Task 5 Step 3. ✓
- 🟡 `rapid_dup` multi-fire → Task 3 Steps 4-5. ✓
- 🟡 Notify wrong permission → Task 3 Step 6. ✓
- 🟡 Notify null-contextKey email → Task 3 Step 7. ✓
- 🟡 Bulk-ack partial failure → Task 6 Step 5. ✓
- 🟡 Client filter pagination total → Task 6 Step 6. ✓
- 🟡 `toggleRule` 200-vs-400 → Task 3 Step 8. ✓
- 🟡 Stub rules → Task 4 Step 1. ✓
- 🟡 Missing dedup index → Task 4 Step 2. ✓
- 🟡 No throttler → Task 2 Step 3. ✓
- 🟡 No OTel/PostHog/Sentry → Task 4 Step 3. ✓
- 🟡 i18n untranslated + hardcoded strings → Task 6 Step 3, Task 7. ✓
- 🟡 Page wrapper width → Task 6 Step 2. ✓
- 🟡 Dead `loadRules` / `catch(any)` → Task 6 Step 4. ✓
- 🟢 Severity icon → Task 6 Step 7. ✓
- 🟢 No `loading.tsx` → Task 6 Step 8. ✓
- Decision: gate matching siblings → Task 1 Step 3, Task 5 Step 1. ✓
- Decision: remove stub rules → Task 4 Step 1. ✓

No gaps.

**Type consistency** — the sub-feature key string `anomaly_detection` is used identically in Tasks 1, 2, 5. The `MANAGE_ANOMALIES` permission is referenced consistently in Tasks 3 (notify) and 5 (web guard). The `ShiftSnapshot` timezone addition in Task 3 Step 3 is the only new type surface and is self-contained to `anomaly-detection.service.ts`.

**Sequencing** — Task 1 defines the canonical key before Tasks 2/5 consume it. Backend Tasks 1-4 and web Tasks 5-7 are otherwise independent and may run in either order; within web, Task 5 and 6 both edit `anomalies/page.tsx` so they must run sequentially (5 then 6), and Task 7 depends on Task 6 introducing new keys.
