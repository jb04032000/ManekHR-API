# ADR-0001 — Migration ledger + ordered runner (decouple seeds/backfills from HTTP boot)

- **Status:** ACCEPTED — approved with the §6 recommended defaults.
  - **Slice 1 (Connect) shipped** (`042e827`): ledger + runner + lock + `npm run migrate` CLI + `RUN_MIGRATIONS_ON_BOOT`, and the 7 Connect units moved off boot.
  - **Slice 2 (Finance) shipped** (`b1ff911`): units 0008–0011 — gst-rate-history (once), inventory backfill (once), cess rules (convergent), greeting templates (convergent). **Deferred from Slice 2 for review:** `print-i18n` (not a DB seed — loads i18n JSON into memory; stays on boot), `inventory.module` (no hook of its own), `hsn` (onModuleInit also warms a runtime cache — needs a seed/cache split), `migrate-rcm-output-tax` (already env-gated/dormant; converting drops its dry-run-at-boot).
  - **Slice 3 (RBAC/team/leave/salary) shipped** (`3b4b5f3`): units 0012–0027 — the 16 backfills/migrations that still ran unconditionally in `MigrationsModule.onModuleInit` (all `once`). After this slice `onModuleInit` runs NOTHING unconditionally; only the 4 ERP default-data seeds remain, still gated by `SEED_DEFAULTS_ON_BOOTSTRAP`.
  - **Slice 4 (ERP default-data seeds) shipped** (`e754bb3`): units 0028–0031 (default tiers+plans, add-ons, msg91 costs, platform auth-OTP workspace — all `convergent`). Deleted the `onModuleInit` method + the `SEED_DEFAULTS_ON_BOOTSTRAP` gate; `MigrationsModule` is now a pure wiring module. **`MigrationsModule` does ZERO work on boot** — Finding 3's core goal for the central module is met.
  - **Slice 5 (platform + subscription plan-migrations) shipped** (`b66f53f`): units 0032–0035 — attendance/finance/machines plan-migrations (`once`) + localization language seed (`convergent`). `LocalizationModule` is now a plain module; MigrationsModule imports it + `SubscriptionsModule` (which now exports the 3 plan-migration services).
  - **Loose ends shipped** (`c9ca98f`): unit **0036 HSN codes** (convergent) — split `hsn.service`: `seedIfMissing` (now public) runs via the runner, `refreshCache` cache-warm stays in `onModuleInit` (runtime read, not a DB write); MigrationsModule imports `HsnModule`. Unit **0037 PT slabs** (convergent) — new dedicated `src/migrations/seed-pt-slabs.ts` (injects only `PtSlabConfig`, no heavy `AdminModule` import); removed `admin.service`'s `onModuleInit` + moved method.
  - **Decisions on the rest:**
    - `migrate-rcm-output-tax` — **left dormant by design.** It is env-gated (`RCM_OUTPUT_TAX_MIGRATION=dry-run|apply`) and a no-op on a normal boot, so it is NOT a per-boot cost. Ledgering it would force apply-mode and drop its operator dry-run-preview. No change.
    - `print-i18n` — **resolved: stays on boot** (loads i18n JSON into memory; not a DB seed). `inventory.module` — **resolved: n/a** (no hook of its own).
  - **Only remaining item (flagged, NOT done — genuinely entangled):** `subscriptions.service.onApplicationBootstrap` mixes (a) an AppSettings singleton seed, (b) a "Free Forever" plan FALLBACK that overlaps unit 0028's canonical tiers/plans seed, (c) `repairEmptyModuleAccess` + `repairMissingSubFeatures` backfills, and (d) `refreshTierCache` — a RUNTIME tier-cache warm that must stay on boot. Recommended split: keep `refreshTierCache` in `onApplicationBootstrap`; move the AppSettings seed + the two repairs to ledger units; and DROP the Free-plan fallback only after confirming 0028 fully supersedes it (needs a fresh-DB + free-tier-signup boot test). Deferred — too product-risky to do blind. Everything else from Finding 3 is now ledgered (37 units) or intentionally on-boot (runtime cache warms only).
- **Date:** 2026-06-13
- **Source:** `CONNECT-BACKEND-STARTUP-AUDIT.md` → Finding 3 (P1, behavioural change)
- **Relates to:** `docs/architecture/scheduler-contract.md` (reuses its Redis single-flight lock + `PROCESS_ROLE` split)

---

## 1. Context — what runs on boot today (verified, not assumed)

Two mechanisms write/seed to Mongo during application start. The audit's Finding 3
under-counted both; the verified inventory is below.

### (a) Central `src/migrations/migrations.module.ts` (`onModuleInit`)

26 services are registered. **Only the 6 true seeds are gated** by
`SEED_DEFAULTS_ON_BOOTSTRAP`; the audit said "24 gated", but in fact:

**Always-on (run every boot, ignore the flag) — 19:**
`migrate-pro-to-growth`, `migrate-team-app-access-to-workspace-members`,
`seed-default-member-role-existing-workspaces`, `backfill-permission-scopes`,
`backfill-worker-regularization-grant`, `seed-leave-types-existing-workspaces`,
`backfill-leave-role-grants`, `backfill-workspaces-view-role-grants`,
`backfill-role-permission-paths`, `backfill-role-attendance-permission-paths`,
`migrate-team-overrides-to-paths`, `strip-attendance-mark-edit-self-scope`,
`backfill-leave-self-service-grant-deps`, `backfill-hr-salary-sensitive-view`,
`backfill-team-member-workspaceid-objectid`, `migrate-workspace-member-partial-index`,
`backfill-connect-product-and-indexes`, `backfill-connect-subfeature-keys`,
`backfill-listing-storefront`.

**Gated by `SEED_DEFAULTS_ON_BOOTSTRAP` — 6 (the actual seeds):**
`seed-default-tiers-and-plans`, `seed-connect-tiers-and-plans`, `seed-connect-tags`,
`seed-default-add-ons`, `seed-msg91-costs`, `seed-platform-auth-otp-workspace`.

Each always-on service issues at least one Mongo query on every boot, even when there
is nothing to do. Order is implicit in constructor/`onModuleInit` sequence. All failures
are caught and logged (fail-open) — a broken migration is invisible unless someone reads
the boot log.

### (b) Scattered always-on lifecycle hooks (NOT gated) — 16

Each runs on **every** boot via `onModuleInit`/`onApplicationBootstrap`:

- **Connect:** `connect/ads/ads.module` (seeds ad placement slots + pricing-config
  singleton via `$setOnInsert`), `connect/marketplace/services/listing.service`
  (`updateMany` moderation backfill).
- **Finance:** `gst/gst-rate-history`, `hsn`, `inventory/migrations/inventory-migration`,
  `inventory/cess/cess-rules.seed`, `inventory/inventory.module`,
  `reminders/reminder-template`, `sales/print-i18n`,
  `purchases/purchase-bill/migrations/migrate-rcm-output-tax` _(missed by the audit)_.
- **Subscriptions:** `attendance-plan-migration`, `finance-plan-migration`,
  `machines-plan-migration`, `subscriptions.service`.
- **Platform:** `localization/localization.module`, `admin/admin.service`.

(Not in scope — these `onModuleInit` hooks are legitimate runtime wiring, not seeds:
`finance/reminders/adapters/push.adapter` (Firebase init).)

## 2. Problems

1. **Avoidable DB round-trips + log noise on every boot** (35+ seed/backfill passes),
   most doing nothing after the first successful run.
2. **No audit trail** — nothing records _what_ migration ran, _when_, how long, or
   whether it succeeded. "Did the prod DB get backfill X?" is unanswerable.
3. **Fail-open** — a migration that throws is swallowed; data can be silently half-migrated.
4. **Accidental-write risk at boot** — every HTTP server instance (and CI smoke boot)
   can mutate production data just by starting.
5. **Implicit ordering** — correctness depends on the textual order of `onModuleInit`
   blocks and module registration; fragile and undocumented.

## 3. Decision

Introduce a **migration ledger + a single ordered runner**, invoked **explicitly**
(deploy step / CLI), not inside HTTP-server boot. Convert the boot hooks module-by-module,
**Connect first**.

### 3.1 Ledger collection — `migrations`

| field        | type                     | purpose                                                     |
| ------------ | ------------------------ | ----------------------------------------------------------- |
| `name`       | string, **unique**       | stable migration id, e.g. `0007_connect_listing_storefront` |
| `checksum`   | string                   | hash of the migration's seed payload / logic version        |
| `status`     | enum `applied \| failed` | outcome of the last attempt                                 |
| `appliedAt`  | Date                     | when it completed                                           |
| `durationMs` | number                   | runtime                                                     |
| `error`      | string?                  | message on failure (no PII)                                 |
| `runner`     | string?                  | host/instance + git sha that applied it                     |

### 3.2 Migration unit

A migration is a small object/class:

```
{ name: '0007_connect_listing_storefront',
  kind: 'once' | 'convergent',
  checksum?: string,           // required for 'convergent'
  run(ctx): Promise<Summary> }
```

- **`once`** — one-shot data migration. Skipped forever once `name` is in the ledger
  (the ~19 backfills + the finance one-shots).
- **`convergent`** — a seed whose data may change (tiers/plans/add-ons/msg91 costs/ad
  placements/pricing). Re-applied **only when `checksum` changes** — so a price/plan
  edit propagates on the next migrate run, without re-querying every boot.

Existing `*.run()/*.runSeed()` bodies are **reused unchanged** — we only wrap them as
migration units and change _when/how_ they're invoked.

### 3.3 Runner

- Reads the ledger once, computes the pending set (declared-but-not-applied `once`
  - checksum-changed `convergent`), runs them **in an explicit ordered registry**
    (numbered prefixes), records `applied`/`failed` + timing per unit.
- **Fail-closed:** on any failure the runner exits non-zero so the deploy halts
  (today's fail-open is removed). Already-applied units are never re-touched.
- Logs each unit through the Finding 2 structured logger (one line per migration).

### 3.4 Concurrency

Wrap the whole run in the existing **Redis single-flight lock** (from
`scheduler-contract.md`) so concurrent web/worker instances never double-run. Falls back
to a Mongo advisory lock doc if Redis is absent.

### 3.5 Invocation (the key behavioural change)

- New `npm run migrate` command (a thin Nest standalone-application context that builds
  the providers, runs the runner, exits). Wired as an explicit **deploy/CI-CD step**
  before the app rolls out.
- **HTTP-server boot stops running migrations entirely.**
- **Fresh-dev convenience:** an opt-in `RUN_MIGRATIONS_ON_BOOT` flag (default `false`,
  honoured only on `PROCESS_ROLE=worker|all`) runs the same runner once at boot for
  local fresh DBs. Read through `src/config/env.ts` (replaces the ad-hoc
  `SEED_DEFAULTS_ON_BOOTSTRAP` `ConfigService` read).

### 3.6 Seeding an existing prod DB safely

On first runner execution against a DB that predates the ledger, **pre-stamp every
`once` migration whose effect is already present as `applied`** (a one-time
"baseline" import) so historical backfills don't re-run or fail. New environments
start from an empty ledger and apply everything in order.

## 4. Conversion plan (module-by-module, Connect first)

Each step: wrap the existing service as a ledgered unit, add it to the ordered registry,
delete its `onModuleInit`/`onApplicationBootstrap` hook, verify the boot no longer runs it
and the runner does. Ship one module per slice for reviewability.

- **Slice 1 — Connect (first):** `backfill-connect-product-and-indexes`,
  `backfill-connect-subfeature-keys`, `backfill-listing-storefront`,
  `seed-connect-tiers-and-plans`, `seed-connect-tags`, `ads.module` placement+pricing
  seed, `listing.service` moderation backfill.
- **Slice 2 — Finance:** gst-rate-history, hsn, inventory-migration, cess-rules,
  inventory.module, reminder-template, print-i18n, migrate-rcm-output-tax.
- **Slice 3 — RBAC / Team / Leave / Salary backfills** (the 12 permission/role/member ones).
- **Slice 4 — Subscriptions:** plan-migrations (attendance/finance/machines), pro→growth,
  tiers/plans/add-ons/msg91/auth-otp seeds, subscriptions.service hook.
- **Slice 5 — Platform:** localization.module, admin.service.

## 5. Consequences

**Positive:** quiet, fast boots; a queryable audit trail of what ran; deploy halts on a
bad migration; no accidental writes from an HTTP instance or CI smoke; explicit,
documented ordering.

**Negative / cost:** a new deploy step the owner must wire into CI-CD; one-time baseline
import on the existing prod DB; ~35 hooks to convert across 5 slices (staged, low-risk
each). Behaviour-preserving per unit (same `run()` logic), so functional risk is low.

## 6. Decisions needing owner approval

1. **Invocation** — explicit CI-CD/CLI step + opt-in dev-boot flag _(recommended)_, vs
   keep auto-on-boot behind a flag.
2. **Failure policy** — fail the deploy on a migration error _(recommended)_, vs today's
   log-and-continue.
3. **Convergent seeds** — keep tiers/plans/add-ons/pricing/placements re-appliable by
   checksum via the runner _(recommended)_, vs make everything one-shot.
4. **Lock** — reuse the existing Redis single-flight lock _(recommended)_, vs Mongo
   advisory doc.

No code is written until this ADR is approved.
