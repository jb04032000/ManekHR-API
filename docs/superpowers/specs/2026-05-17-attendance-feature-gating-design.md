# Attendance Feature Gating — Design Spec

**Date:** 2026-05-17
**Status:** Approved scope + tier matrix, pending spec review
**Repos:** crewroster-backend (registry, endpoints, migration), crewroster-web (registry, FeatureGate, dead-code removal)

## 1. Goal

Tier-gate four existing attendance features as enforced subscription sub-features, and fix the admin custom-plan-assignment 400 caused by feature-registry drift between web and backend.

## 2. Background — the bug

The web `FEATURE_ACCESS_REGISTRY` (`crewroster-web/lib/constants/feature-access.registry.ts`) and the backend `MODULE_FEATURES_REGISTRY` (`crewroster-backend/src/common/constants/module-features.registry.ts`) are two separately hand-maintained registries that have drifted. The web registry's `attendance` module lists five sub-feature keys the backend has never had: `live_presence`, `attendance_muster`, `overtime_analytics`, `compliance_report`, `absence_patterns`. The admin plan-builder builds a custom plan's `moduleAccess` from the web registry; the backend `validateModuleAccess` (`subscription.dto.ts`) validates against the backend registry → unknown keys → `400 Invalid sub-feature key`.

## 3. Scope

**In scope** — gate four features:

- `attendance_muster` — the "Register" toggle in Overview's Member Breakdown (mounts `AttendanceMusterView`).
- `overtime_analytics` — the `/dashboard/attendance/overtime` page.
- `compliance_report` — the `/dashboard/attendance/compliance` page.
- `absence_patterns` — the `/dashboard/attendance/patterns` page.

Each gets: a backend registry entry, a `TIER_SUBFEATURE_DEFAULTS` seed, `@RequireSubscription` enforcement on its read endpoint, and web `<FeatureGate>` / `useFeatureAccess` enforcement.

**Out of scope / dropped:**

- `live_presence` — fully retired. `crewroster-web/app/dashboard/attendance/live/page.tsx` is a `redirect()` to the Mark page; `AttendanceLiveView.tsx` is dead code with zero importers; the `GET /attendance/live-presence` endpoint's only consumer was that dead component. There is no live-presence surface to gate. It is **removed** from the web registry and never added to the backend. Dead `AttendanceLiveView.tsx` is deleted. The `live/` redirect route is kept (preserves old bookmarks).
- Rebuilding a live-presence surface — not done.

## 4. Tier matrix (approved)

Anchored to the existing attendance policy (`analytics_charts` / `statutory_exports` are LOCKED on free + starter, FULL pro+; operational features unlock at starter).

| Feature              | free   | starter | pro  | growth | business | enterprise | custom |
| -------------------- | ------ | ------- | ---- | ------ | -------- | ---------- | ------ |
| `attendance_muster`  | LOCKED | FULL    | FULL | FULL   | FULL     | FULL       | FULL   |
| `overtime_analytics` | LOCKED | LOCKED  | FULL | FULL   | FULL     | FULL       | FULL   |
| `compliance_report`  | LOCKED | LOCKED  | FULL | FULL   | FULL     | FULL       | FULL   |
| `absence_patterns`   | LOCKED | LOCKED  | FULL | FULL   | FULL     | FULL       | FULL   |

All four are `supportsLimited: false` — whole pages, on/off, no quota'd middle tier (access is only LOCKED or FULL).

## 5. Backend changes

### 5.1 Registry catalogue

Add four sub-feature entries to the `ATTENDANCE` module in `MODULE_FEATURES_REGISTRY`
(`src/common/constants/module-features.registry.ts`): `attendance_muster`, `overtime_analytics`,
`compliance_report`, `absence_patterns` — each `{ key, label, description, supportsLimited: false }`.
This alone makes `validateModuleAccess` accept them → fixes the 400.

### 5.2 Tier defaults for new subscriptions

Add a `_ATTENDANCE_GATING_TIER_DEFAULTS` block + merge loop (mirroring `_DEFAULTER_ALERTS_TIER_DEFAULTS`
from the prior feature) so `buildModuleAccess(tier)` seeds the four keys per the §4 matrix for newly
created subscriptions.

### 5.3 Enforcement — `@RequireSubscription` on read endpoints

Add `@RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: <key> })` to the four read
endpoints in `src/modules/attendance/attendance.controller.ts`:

| Sub-feature          | Endpoint                                          | Handler                |
| -------------------- | ------------------------------------------------- | ---------------------- |
| `attendance_muster`  | `GET /workspaces/:id/attendance/grid`             | `getAttendanceGrid`    |
| `overtime_analytics` | `GET /workspaces/:id/attendance/overtime`         | `getOvertimeAnalytics` |
| `compliance_report`  | `GET /workspaces/:id/attendance/compliance`       | `getComplianceReport`  |
| `absence_patterns`   | `GET /workspaces/:id/attendance/absence-patterns` | `getAbsencePatterns`   |

Note: attendance **read** endpoints are not currently gated (only writes/exports). This is the first
read-gating in the module — acceptable; the `SubscriptionGuard` runs on GETs the same way.

### 5.4 Tier-aware backfill migration

Without backfill, the four new keys are absent from every existing plan's and subscription's
`moduleAccess`; since the `attendance` `subFeatures` array is non-empty, `SubscriptionGuard` resolves
an absent key to `LOCKED` — so all four would 403 for everyone until the migration runs.

Extend the existing `AttendancePlanMigrationService` (`src/modules/subscriptions/attendance-plan-migration.service.ts`)
with a second pass. Unlike the `defaulter_alerts` pass (everyone → FULL), this pass is **tier-aware**:

- For each `Plan`: resolve the plan's `tier`; for each of the four keys missing from the `attendance`
  `moduleAccess` entry's `subFeatures`, push `{ key, access }` with the access from
  `TIER_SUBFEATURE_DEFAULTS[tier].attendance.<key>` (§4 matrix).
- For each `Subscription`: resolve the tier via its populated `planId.tier`; backfill the four keys
  into `appliedEntitlements.moduleAccess` (and `adminEntitlementOverride.moduleAccess` when present)
  the same tier-aware way.
- Tier resolution fallback: if a plan/subscription has no resolvable tier, use `free` (consistent
  with `buildModuleAccess`'s own fallback). Log the count of unresolved documents.
- Idempotent: only push a key that is not already present in the `subFeatures` array (per-document
  check, not a blind `$addToSet` — because the access value is tier-dependent, a blind `$addToSet`
  of a differently-valued object would create duplicate keys). Iterate documents and update each.
- Wrapped in try/catch — never crash boot.

**Consequence (approved):** existing free workspaces lose all four pages; existing starter
workspaces lose the three analytics pages (keep `attendance_muster`). This is the intended
"full enforcement" behaviour.

## 6. Web changes

### 6.1 Registry + dead code

- Remove the `live_presence` entry from the `attendance` module in
  `crewroster-web/lib/constants/feature-access.registry.ts`. The other four keys already exist there
  and now match the backend.
- Delete `crewroster-web/components/dashboard/attendance/AttendanceLiveView.tsx` (dead — zero importers).
- Delete `crewroster-web/app/dashboard/attendance/live/loading.tsx` (a `loading.tsx` for a route that
  only `redirect()`s never renders). Keep `live/page.tsx` (the redirect stub for old bookmarks).

### 6.2 Page gating — overtime, compliance, patterns

Wrap each page's content in `<FeatureGate module="attendance" subFeature="<key>">`:

- `app/dashboard/attendance/overtime/page.tsx` → `overtime_analytics`
- `app/dashboard/attendance/compliance/page.tsx` → `compliance_report`
- `app/dashboard/attendance/patterns/page.tsx` → `absence_patterns`

A locked tier sees `<UpgradePrompt>` instead of the page. The Compliance page already contains a
nested `<FeatureGate subFeature="defaulter_alerts">` around the defaulter-alerts card — when
`compliance_report` is locked the whole page is gated, so the inner card is naturally unreachable;
no conflict.

### 6.3 `attendance_muster` — gate the Register toggle

In `app/dashboard/attendance/overview/AttendanceOverviewClient.tsx`'s Member Breakdown:

- Use `useFeatureAccess('attendance', 'attendance_muster')`.
- When locked: render the "Register" toggle button **disabled**, with a lock icon and a tooltip
  ("Upgrade to unlock"). Keep "Summary" always available.
- If `breakdownView === 'register'` while locked (e.g. stale state), render an inline
  `<UpgradePrompt>` (or the `<FeatureGate>` fallback) in place of `<AttendanceMusterView>`.
- Default `breakdownView` stays `'summary'`, so a locked workspace lands on Summary normally.

## 7. Edge cases

- Custom plans (`tier: 'custom'`) → all four FULL (matrix).
- A subscription whose plan tier is unresolvable → migration applies `free` defaults; logged.
- Re-run of the migration → per-document presence check makes it a no-op.
- A workspace downgraded after the migration → the next plan/subscription recompute applies the new
  tier's matrix; the `SubscriptionGuard` enforces live on every request regardless.
- `compliance_report` locked → Compliance page gated → `defaulter_alerts` card unreachable (expected).

## 8. Testing

Vitest, colocated `*.vitest.ts`.

- Registry: the four keys catalogued; `buildModuleAccess(tier)` yields the §4 matrix per tier.
- Migration: tier-aware backfill writes the correct access per tier; idempotent on re-run; unresolved
  tier → `free` fallback.
- Web: `tsc` + `eslint` clean; manual check that locked tiers see the upgrade prompt on the three
  pages and the disabled Register toggle.

## 9. Files touched

**crewroster-backend**

- `src/common/constants/module-features.registry.ts` — 4 registry entries + tier-defaults block + merge loop.
- `src/modules/attendance/attendance.controller.ts` — `@RequireSubscription` on 4 endpoints.
- `src/modules/subscriptions/attendance-plan-migration.service.ts` — tier-aware backfill pass.
- Tests under the relevant `__tests__/`.

**crewroster-web**

- `lib/constants/feature-access.registry.ts` — remove `live_presence`.
- `components/dashboard/attendance/AttendanceLiveView.tsx` — delete (dead).
- `app/dashboard/attendance/live/loading.tsx` — delete.
- `app/dashboard/attendance/overtime/page.tsx`, `compliance/page.tsx`, `patterns/page.tsx` — `<FeatureGate>` wrap.
- `app/dashboard/attendance/overview/AttendanceOverviewClient.tsx` — gate the Register toggle.

## 10. Process notes

- Assistant runs no git commands; the owner stages and commits, including this spec.
- This is a logical feature change with customer-facing impact (existing free/starter workspaces lose
  pages) — approved by the owner under "full enforcement".
