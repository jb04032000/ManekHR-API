# Attendance Defaulter Notification — Design Spec

**Date:** 2026-05-17
**Status:** Approved scope, pending spec review
**Repos:** crewroster-backend (primary), crewroster-web (config UI)

## 1. Goal

When employees fall below the workspace attendance threshold for a **completed**
calendar month, automatically notify configured recipients (managers and/or
owner-specified people) via in-app notification and/or email. Today the
compliance threshold only filters a table on the Compliance page — nobody is
notified. This feature closes that gap.

## 2. Scope

**In scope**

- Per-workspace config block (`defaulterAlerts`).
- Monthly cron that evaluates the previous closed month.
- Dispatch service with recipient resolution.
- In-app notification channel.
- Email channel + Handlebars template.
- Config UI on the Compliance page.
- Subscription feature gate.
- Audit logging.

**Out of scope (deferred — explicit owner decision 2026-05-17)**

- SMS channel — needs a DLT-approved MSG91 template the owner must register
  with the operator. Fast-follow once that template exists.
- Mobile push — future pass. The dispatch layer is built channel-agnostic so
  push slots in later as one adapter; no push stub ships now.
- Manual "Send alerts now" button.

## 3. Why monthly, not daily

Attendance defaulter status is a **monthly** metric — the entire Compliance
page is month-scoped. A daily cron would (a) burn backend cycles for a metric
that changes slowly and (b) fight month-to-date rate volatility (one absence on
day 2 of the month reads as 50%). Evaluating a **closed** month gives final,
accurate rates and runs the cron exactly once per month.

The Compliance page itself keeps computing defaulters **on page visit only** —
no background computation is added for display. The monthly cron is the sole
new background job.

## 4. Feature gate — dynamic subscription integration

### 4.1 How the subscription system works (audited)

- Plans are **dynamic** — admin-created `Plan` documents, not a fixed enum.
  Each plan stores `entitlements.moduleAccess[]`, an array of per-module
  `{ module, enabled, subFeatures: [{ key, access }] }`.
- `MODULE_FEATURES_REGISTRY` (`src/common/constants/module-features.registry.ts`)
  is the static **catalogue** of every module + sub-feature that can exist. The
  admin plan-builder reads it via `GET /subscriptions/feature-registry` to know
  which features are assignable.
- `TIER_SUBFEATURE_DEFAULTS` + `buildModuleAccess(tier)` seed a tier-template's
  `moduleAccess` — consumed when **fresh** subscriptions are created, never for
  existing ones.
- A subscription **freezes a snapshot** into `appliedEntitlements` at subscribe
  time. `SubscriptionGuard` reads `subscription.appliedEntitlements` (falling
  back to the live `plan.entitlements`) — it does **not** read the registry.
- `FeatureAccessLevel` = `LOCKED | LIMITED | FULL`.

### 4.2 The critical pitfall

`SubscriptionGuard` (`src/common/guards/subscription.guard.ts:200-217`) resolves
a sub-feature like this:

```
accessLevel = subFeatureEntry?.access
  || (moduleEntry.subFeatures.length === 0 ? FULL : LOCKED)
```

The `attendance` module entry already carries a **non-empty** `subFeatures`
array in every existing Plan and Subscription (`mark`, `edit`, `bulk_mark`, …).
So a newly added `defaulter_alerts` key absent from those frozen snapshots
resolves to **`LOCKED` → 403 — for every existing customer, free and paid
alike.** Adding the key to the registry alone is not enough; existing data must
be backfilled. The Wave 4 finance migration comment states this exactly:
_"the fallback breaks the moment the array gets even one entry."_

### 4.3 The four required pieces

1. **Registry catalogue** — add
   `{ key: 'defaulter_alerts', label: 'Defaulter Alerts', description: '…', supportsLimited: false }`
   to the `ATTENDANCE` entry in `MODULE_FEATURES_REGISTRY`. `supportsLimited:
false` — the feature is on/off, no quota'd middle state. The admin
   plan-builder then lists it automatically.

2. **Tier seed for NEW subscriptions** — add a `_DEFAULTER_ALERTS_TIER_DEFAULTS`
   block plus a merge loop, mirroring `_WAVE4_FINANCE_REMINDERS_TIER_DEFAULTS`,
   so `buildModuleAccess(tier)` seeds `attendance.defaulter_alerts` for freshly
   created tier-templates. Suggested seed: `free → LOCKED`, paid tiers → `FULL`.
   This affects only fresh subscriptions — never existing ones (see #3). The
   seed is the only pricing knob; the owner may change it.

3. **Boot-time backfill migration** — a new `AttendancePlanMigrationService
implements OnModuleInit`, registered in the subscriptions module, following
   `FinancePlanMigrationService` exactly. On every boot, idempotently `$addToSet`
   the entry `{ key: 'defaulter_alerts', access: FULL }` into the `attendance`
   module's `subFeatures` array of:
   - every `Plan.entitlements.moduleAccess`,
   - every `Subscription.appliedEntitlements.moduleAccess`,

   using `arrayFilters: [{ 'elem.module': AppModule.ATTENDANCE }]`. `$addToSet`
   with the full `{ key, access }` object is idempotent (object equality).
   Wrapped in try/catch so a migration hiccup never crashes boot.

   **Backfill access = `FULL`** — this matches the established codebase
   convention (`FinancePlanMigrationService`: _"existing tenants grandfather to
   FULL on every new key — tier locking only applies to fresh subscriptions via
   `buildModuleAccess`; admins re-tighten per-plan via the plan-editor"_).
   `defaulter_alerts` is brand new, so granting it to existing tenants is purely
   additive — never a regression. An admin who wants it to be a paid-only upsell
   tightens specific plans in the plan-editor afterward.

4. **Enforcement**
   - Config endpoint `PATCH /workspaces/:id/defaulter-alerts` gated with
     `@RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'defaulter_alerts' })`.
   - The monthly cron re-checks each `enabled` workspace's
     `appliedEntitlements.moduleAccess` for `attendance → defaulter_alerts`;
     skips dispatch if `LOCKED` (a workspace downgraded after enabling), without
     flipping the stored `enabled` flag.
   - Web mirrors the key in `crewroster-web/lib/constants/feature-access.registry.ts`;
     the config card is wrapped in `<FeatureGate module="attendance"
subFeature="defaulter_alerts">`, which renders `<UpgradePrompt>` when
     locked. `useFeatureAccess('attendance', 'defaulter_alerts')` is available
     for finer-grained checks.

## 5. Config schema

New sub-document on `workspace.attendanceSettings`:

```
defaulterAlerts: {
  enabled: boolean            // default false — opt-in; false => cron skips workspace
  channels: {
    inApp: boolean            // default true
    email: boolean            // default false
  }
  recipients: {
    mode: 'managers' | 'specificPeople' | 'both'   // default 'managers'
    specificPeople: ObjectId[]                      // userIds; default []
  }
}
```

- Schema sub-doc with `_id: false` and defaults so existing workspaces read
  sane values without a migration.
- The threshold is **not** duplicated here — it reuses the existing
  `attendanceSettings.complianceThresholdPct` (the same value the Compliance
  page slider drives), so the page and the alerts always agree.

## 6. API

A **dedicated** endpoint, mirroring the existing `PATCH /workspaces/:id/kiosk`
and `/employee-code-settings` pattern — so the `defaulter_alerts` subscription
gate does not leak onto the shared `PATCH /workspaces/:id` settings endpoint.

```
PATCH /workspaces/:id/defaulter-alerts
  Guards:  @RequirePermissions(WORKSPACES, EDIT)
           @RequireSubscription(ATTENDANCE, defaulter_alerts)
  Body:    DefaulterAlertsConfigDto
  Returns: updated Workspace
```

`DefaulterAlertsConfigDto` (class-validator):

- `enabled` — boolean.
- `channels` — nested DTO, `inApp` / `email` booleans.
- `recipients` — nested DTO: `mode` enum, `specificPeople` array of Mongo
  ObjectId strings, each validated; `specificPeople` must reference active
  members of the workspace (service-level check, 422 otherwise).

Service method `updateDefaulterAlertsConfig(workspaceId, dto)` persists via
`$set` on `attendanceSettings.defaulterAlerts` and returns the updated doc.

Web API client gains `workspacesApi.updateDefaulterAlerts(id, dto)`.

## 7. Monthly cron — `DefaulterAlertCron`

- File: `src/modules/attendance/crons/defaulter-alert.cron.ts`.
- Schedule: 1st of each month, ~06:00 IST. Add a `CRON_SCHEDULES` entry
  (`0 6 1 * *`) and a `CronJobKey` entry in `src/common/constants/cron.constants.ts`.
- Algorithm:
  1. Compute the previous month/year (the just-closed month).
  2. Query workspaces where `attendanceSettings.defaulterAlerts.enabled === true`.
  3. For each workspace:
     a. Verify subscription entitlement for `defaulter_alerts` — skip if not.
     b. Check idempotency — skip if a dispatch row already exists for
     `(workspaceId, periodKey)`.
     c. Compute previous-month compliance via
     `attendanceService.getComplianceReport(wsId, prevMonth, prevYear)`.
     d. Filter defaulters: `attendanceRate !== null && attendanceRate < complianceThresholdPct`.
     e. If 0 defaulters — write the idempotency row (count 0) and continue.
     f. If ≥1 — call `DefaulterAlertService.dispatch(...)`, then write the
     idempotency row with counts.
  4. Each workspace is wrapped in its own try/catch so one failure does not
     abort the run. Wrap the run in an OTel span (`attendance.defaulter_alert_cron`).

**Idempotency** — new collection `DefaulterAlertDispatch`:

```
{ workspaceId, periodKey: 'YYYY-MM', dispatchedAt, defaulterCount, recipientCount }
```

Unique compound index on `(workspaceId, periodKey)`. The cron checks for an
existing row before doing any work, making re-runs safe.

## 8. Dispatch — `DefaulterAlertService`

File: `src/modules/attendance/defaulter-alert.service.ts`.

`dispatch({ workspace, month, year, defaulters, threshold, config })`:

1. **Resolve recipients** → a deduplicated set of `userId`s:
   - mode includes `managers`: for each defaulter, resolve the manager via
     `TeamMember.reportsTo` → manager's `userId`. If a defaulter has no
     `reportsTo`, fall back to the workspace owner for that defaulter.
   - mode includes `specificPeople`: add `config.recipients.specificPeople`.
   - Deduplicate. If the set is empty, fall back to the workspace owner. If it
     is still empty, log a warning and skip dispatch.
2. **Build the digest** — one message covering all defaulters, not one per
   defaulter (avoids notification spam):
   - Title: `"<N> members below the <T>% attendance threshold — <Month Year>"`.
   - Body / list: each defaulter's name, designation, attendance rate.
   - Deep link: `/dashboard/attendance/compliance?month=<m>&year=<y>`.
3. **Per recipient, per enabled channel:**
   - `channels.inApp` → `notificationsService.createNotification(wsId, {
recipientId, title, message, type: 'warning',
metadata: { category: 'ATTENDANCE_DEFAULTER', month, year, link } })`.
   - `channels.email` → resolve the recipient's email →
     `mailService.checkEmailQuota(wsId)` → render `defaulter-alert.hbs` →
     send. If the quota is exceeded, skip email for that recipient and log;
     in-app still sends.
4. **Audit** each outcome via `AuditService.logEvent` (module `ATTENDANCE`)
   with action `attendance.defaulter_alert_sent` or `attendance.defaulter_alert_failed`.
5. Return `{ recipientCount, channelsSent, failures }` for the cron to log and
   store on the `DefaulterAlertDispatch` row.

Channel dispatch sits behind a small internal channel map so a mobile-push
adapter can be registered later without touching the resolution or digest
logic. No push adapter is shipped now.

## 9. Email template — `defaulter-alert.hbs`

New Handlebars template in `src/modules/mail/templates/`. Brand context is
auto-injected by the existing mailer hook (`{{brand.*}}`). Content: heading,
month, threshold, a table of defaulters (name, designation, rate %), and a CTA
button linking to the Compliance page. Visual style follows the existing
`anomaly-alert.hbs` template.

## 10. In-app notification category

Add `ATTENDANCE_DEFAULTER` to the notification `category` set used by the
`me-notifications` surface, so these alerts are filterable alongside existing
categories (e.g. `INVITE_RECEIVED`).

## 11. Config UI

A new **"Defaulter alerts"** card on the Compliance page, below the existing
threshold card:

- Enable toggle.
- Channel checkboxes: **In-app** (default on), **Email**.
- Recipient picker: a radio group — Managers / Specific people / Both — and,
  when Specific people or Both is selected, a multi-select of active workspace
  members.
- Save calls `PATCH /workspaces/:id/defaulter-alerts`.
- The whole card is wrapped in the entitlement gate for
  `attendance.defaulter_alerts`; locked tiers see an upgrade prompt.
- Editing requires owner or `workspaces.edit` — controls render read-only
  otherwise, matching the existing threshold slider behaviour.
- All copy added to the four locale message files (en, gu-en, hi-en, gu).

## 12. Audit actions

New actions: `attendance.defaulter_alert_sent`,
`attendance.defaulter_alert_failed`, `attendance.defaulter_alerts_config_updated`.

## 13. Edge cases

- 0 defaulters → idempotency row written, nothing sent.
- Workspace `enabled === false` → skipped before any computation.
- Subscription downgraded after enabling → cron skips, `enabled` flag untouched.
- Email channel on but workspace email quota exceeded → skip email for that
  recipient, in-app still sends, logged.
- No recipients resolvable → fall back to workspace owner → if still none,
  log warning and skip.
- Cron re-run → idempotency row makes it a no-op.
- Member with `attendanceRate === null` (no scheduled days) → never a
  defaulter, consistent with the Compliance page.

## 14. Testing

Vitest, colocated under `src/**/__tests__/*.vitest.ts` per backend convention.

- `DefaulterAlertService` — recipient resolution for each mode
  (managers / specificPeople / both), `reportsTo` fallback to owner, empty-set
  fallback; digest construction; email-quota-exceeded path; zero-recipients path.
- `DefaulterAlertCron` — `enabled` filter, entitlement filter, idempotency
  skip, previous-month window calculation, per-workspace error isolation.
- `AttendancePlanMigrationService` — idempotency (a second boot run patches
  nothing), and that the `defaulter_alerts` sub-feature lands in the
  `attendance` module entry of both Plan and Subscription documents.

## 15. Files touched

**crewroster-backend**

- `modules/workspaces/schemas/workspace.schema.ts` — `defaulterAlerts` sub-doc.
- `modules/workspaces/dto/workspace.dto.ts` — `DefaulterAlertsConfigDto`.
- `modules/workspaces/workspaces.controller.ts` / `workspaces.service.ts` —
  `PATCH /:id/defaulter-alerts` + `updateDefaulterAlertsConfig`.
- `common/constants/module-features.registry.ts` — `defaulter_alerts` entry in
  `MODULE_FEATURES_REGISTRY` (ATTENDANCE) + `_DEFAULTER_ALERTS_TIER_DEFAULTS`
  seed block and merge loop.
- `modules/subscriptions/attendance-plan-migration.service.ts` — new boot-time
  backfill migration (precedent: `finance-plan-migration.service.ts`).
- `modules/subscriptions/subscriptions.module.ts` — register
  `AttendancePlanMigrationService` as a provider.
- `common/constants/cron.constants.ts` — schedule + `CronJobKey` entry.
- `modules/attendance/crons/defaulter-alert.cron.ts` — new.
- `modules/attendance/defaulter-alert.service.ts` — new.
- `modules/attendance/schemas/defaulter-alert-dispatch.schema.ts` — new.
- `modules/mail/templates/defaulter-alert.hbs` — new.
- `modules/notifications/` — add `ATTENDANCE_DEFAULTER` category.
- `modules/audit/` — new audit actions.
- Tests under the relevant `__tests__/` folders.

**crewroster-web**

- Compliance page (`app/dashboard/attendance/compliance/page.tsx`) — new
  "Defaulter alerts" config card.
- `lib/api/modules/workspaces.api.ts` — `updateDefaulterAlerts`.
- `lib/constants/feature-access.registry.ts` — mirror the `defaulter_alerts` key.
- `types/index.ts` — `defaulterAlerts` on the `Workspace` type.
- `app/messages/{en,gu-en,hi-en,gu}.json` — new i18n keys.

## 16. Process notes

- Per the workspace standing instruction, the assistant runs **no git
  commands** — the owner stages and commits all changes, including this spec
  document.
- This is a logical (feature) change; the owner has approved building it.
