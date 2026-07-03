# M0 - Connect Monetization Engine Implementation Plan (Phase M0 of the marketplace epic)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]`.
>
> **Decision basis:** `docs/connect/marketplace/2026-05-27-connect-monetization-and-marketplace-foundation.md` (design + the EXTEND verdict + the 3 risks). Read it first.
>
> **Git:** assistant commits per task (owner-authorized for this epic), trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Goal:** Extend the existing ERP billing engine so Connect has its OWN separate plans + wallet-backed credits, person-centric, dynamic/admin-managed, feature-by-feature - shipping dormant and free so we can flip to paid later via config, not code.

**Architecture:** EXTEND, do not duplicate. Add a `product` axis (`erp | connect | bundle`) to `Plan` + `Subscription`, a `connect` sub-block on `PlanEntitlements` (mirroring the existing `storage` / `communications` sub-blocks), Connect `Tier` + `Plan` seed rows, a `ConnectAllowanceService` reading `appliedEntitlements.connect.*`, and a cycle-reset cron that grants included boost credits into the existing person-centric ads wallet. Connect plans run on the same Razorpay + checkout + coupon + admin machinery as ERP.

**Tech Stack:** NestJS + Mongoose, `@nestjs/schedule` crons, vitest (`*.vitest.ts`, decorator-mock pattern), typecheck via `npx nest build` (NEVER whole-project tsc - OOM), eslint on touched files only.

**Backend worktree:** `D:\Work\Projects\Personal\zari360\.worktrees\crewroster-backend\zari360-connect`. Paths below are relative to `src/`.

---

## Money + identity invariants (do not violate)

- Connect is PERSON-CENTRIC: a Connect subscription has `workspaceId: null` and is resolved purely by `userId`. Never inherit the workspace-owner branch for a Connect request.
- Connect wallet = the EXISTING `AdvertiserWallet` (`ownerUserId`), separate from ERP money. Credits are RUPEES on our side.
- Granted (plan-allowance) credits expire each cycle; purchased (PAYG) credits persist. Mark them distinctly.
- No em-dashes anywhere. i18n is web-side (this phase is backend; no i18n keys here).

---

## File Structure

```
Modify:
  modules/subscriptions/schemas/plan.schema.ts        # + PlanConnectEntitlements sub-block, + product field
  modules/subscriptions/schemas/subscription.schema.ts# + product field, product-scoped unique indexes
  modules/subscriptions/schemas/tier.schema.ts        # + product field
  modules/subscriptions/subscriptions.service.ts      # product-aware subscribe() snapshot + normalization branch
  modules/subscriptions/billing/services/admin-plan.service.ts  # accept product + connect entitlements
  modules/subscriptions/billing/dto/*plan*.dto.ts     # + product + connect fields (passthrough)
  modules/connect/ads/services/wallet.service.ts      # + grant vs purchased credit distinction (if not already)
Create:
  modules/connect/monetization/connect-allowance.service.ts     # reads appliedEntitlements.connect.*
  modules/connect/monetization/connect-monetization.module.ts
  modules/connect/monetization/crons/included-credits-grant.cron.ts
  modules/subscriptions/seeds/connect-tiers.seed.ts             # connect_free + connect_premium tiers + plans
  scripts/migrations/2026-05-27-backfill-product-erp.ts         # back-fill existing plans/subs product='erp'
Tests (colocated __tests__/*.vitest.ts next to each unit).
```

---

## Task M0.1: Plan - `product` axis + `connect` entitlements sub-block

**Files:** Modify `modules/subscriptions/schemas/plan.schema.ts`; Test `modules/subscriptions/__tests__/plan-connect-entitlements.vitest.ts`.

- [ ] Step 1 (RED): write a test asserting (a) a new `Plan` defaults `product: 'erp'`, (b) `PlanEntitlements.connect` defaults to `{ maxListings: 0, leadsPerMonth: 0, includedBoostCredits: 0, verifiedBadge: false, searchPriority: 0 }`.
- [ ] Step 2: run it - FAIL (fields absent).
- [ ] Step 3 (GREEN): add the sub-block class + props. Mirror the `PlanStorageEntitlements` precedent exactly:

```ts
@Schema({ _id: false })
export class PlanConnectEntitlements {
  /** Max active marketplace listings. -1 = unlimited. */
  @Prop({ default: 0 }) maxListings: number;
  /** Buyer inquiries / contact unlocks per cycle. -1 = unlimited. */
  @Prop({ default: 0 }) leadsPerMonth: number;
  /** Boost credits granted into the Connect wallet each cycle (expire on reset). */
  @Prop({ default: 0 }) includedBoostCredits: number;
  /** Eligible for the verified marker (further gated on real verification). */
  @Prop({ default: false }) verifiedBadge: boolean;
  /** Ranking weight in marketplace search. 0 = normal. */
  @Prop({ default: 0 }) searchPriority: number;
}
```

Add to `PlanEntitlements`:

```ts
  /** Connect (network/marketplace) allowances. Mirrors storage/communications. */
  @Prop({ type: PlanConnectEntitlements, default: () => ({}) })
  connect: PlanConnectEntitlements;
```

Add to `Plan` (after `tier`):

```ts
  /** Which product line this plan sells. erp = ERP workspace plan; connect = person-centric Connect plan; bundle = both. */
  @Prop({ type: String, enum: ['erp', 'connect', 'bundle'], default: 'erp', index: true })
  product: string;
```

- [ ] Step 4: run test - PASS. `npx nest build` clean.
- [ ] Step 5: commit `feat(connect/monetization): plan product axis + connect entitlements sub-block (M0.1)`.

## Task M0.2: Subscription - denormalized `product` + product-scoped unique index (RISK #1)

**Files:** Modify `modules/subscriptions/schemas/subscription.schema.ts`; Test `modules/subscriptions/__tests__/subscription-product-index.vitest.ts`.

Today `index({ userId: 1 }, { unique, partial: status in [active,trial] })` blocks a person from holding BOTH an active ERP and an active Connect subscription. Fix: denormalize `product` onto the subscription and scope the active/trial + scheduled unique indexes by `product`.

- [ ] Step 1 (RED): test that two `active` subscriptions for the same `userId` with DIFFERENT `product` (`erp`, `connect`) both insert; two with the SAME product collide (duplicate key).
- [ ] Step 2: run - FAIL (current index is userId-only).
- [ ] Step 3 (GREEN): add field + rewrite indexes:

```ts
  /** Denormalized from the plan at subscribe time, so the unique index can scope per product line. */
  @Prop({ type: String, enum: ['erp', 'connect', 'bundle'], default: 'erp', required: true })
  product: string;
```

```ts
SubscriptionSchema.index(
  { userId: 1, product: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['active', 'trial'] } } },
);
SubscriptionSchema.index(
  { userId: 1, product: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'scheduled' } },
);
```

(Leave the `{ userId, workspaceId }` workspace index as-is; Connect subs have `workspaceId: null` + `product: 'connect'`, so no collision.)

- [ ] Step 4: in `subscriptions.service.ts` `subscribe()` / activation paths, set `subscription.product = plan.product` when creating/superseding a subscription (snapshot, same place `appliedEntitlements` is copied). Add a focused test that a created sub carries the plan's product.
- [ ] Step 5: run tests - PASS. `npx nest build` clean.
- [ ] Step 6: commit `feat(connect/monetization): product-scoped subscription uniqueness (M0.2, risk-1)`.

## Task M0.3: Connect-aware entitlement normalization (RISK #2)

**Files:** Modify `modules/subscriptions/subscriptions.service.ts` (the `normalizeEntitlementsForTier` / `repairEmptyModuleAccess` / `buildModuleAccess` paths) + `modules/common/constants/module-features.registry.ts`; Test `modules/subscriptions/__tests__/connect-normalization.vitest.ts`.

The ERP repair/normalize routines rebuild `moduleAccess` from an ERP-only registry and could strip a Connect subscription's entitlements on every `getMySubscription`.

- [ ] Step 1 (discovery): read `normalizeEntitlementsForTier`, `repairEmptyModuleAccess`, `repairMissingSubFeatures`, and `buildModuleAccess(tierKey)` in `subscriptions.service.ts` + the registry, to confirm the exact branch points.
- [ ] Step 2 (RED): test that a `product: 'connect'` subscription with a populated `connect` sub-block + Connect `moduleAccess`, passed through `getMySubscription`, is returned UNCHANGED (connect allowances + Connect module access preserved, not reset to ERP free defaults).
- [ ] Step 3: run - FAIL (ERP normalization clobbers it).
- [ ] Step 4 (GREEN): branch normalization by `subscription.product`. When `'connect'`: skip ERP `buildModuleAccess`, use a Connect module registry entry (define `CONNECT` / `ADS` sub-feature keys: `marketplace.listings`, `marketplace.leads`, `profile.verified_badge`, `search.priority`), and never drop the `connect` sub-block. Keep ERP path byte-identical for `product: 'erp'`.
- [ ] Step 5: run test + the existing subscription tests - PASS (no ERP regression). `npx nest build` clean.
- [ ] Step 6: commit `fix(connect/monetization): connect-aware entitlement normalization (M0.3, risk-2)`.

## Task M0.4: Connect tiers + plans seed (Free generous + Premium)

**Files:** Create `modules/subscriptions/seeds/connect-tiers.seed.ts`; add `product` to `tier.schema.ts`; Test `modules/subscriptions/__tests__/connect-tiers-seed.vitest.ts`.

- [ ] Step 1: add to `tier.schema.ts`: `@Prop({ type: String, enum: ['erp','connect','bundle'], default: 'erp', index: true }) product: string;`
- [ ] Step 2 (RED): test that running the seed creates `connect_free` + `connect_premium` Tier rows (product `connect`) and matching `Plan` rows (product `connect`) with the launch entitlements, and that running it twice is idempotent (no duplicates).
- [ ] Step 3: run - FAIL.
- [ ] Step 4 (GREEN): write the idempotent seed (upsert by `key` / by plan `name`+`product`). Launch values (generous free; admin can retune later):
  - `connect_free`: `connect: { maxListings: 25, leadsPerMonth: -1, includedBoostCredits: 0, verifiedBadge: false, searchPriority: 0 }`, monthlyPrice 0.
  - `connect_premium`: `connect: { maxListings: -1, leadsPerMonth: -1, includedBoostCredits: 500, verifiedBadge: true, searchPriority: 10 }`, monthlyPrice set but plan stays dormant (no one is forced onto it; Free is default).
  - Both: `moduleAccess` with `AppModule.CONNECT` enabled + the sub-feature keys from M0.3.
- [ ] Step 5: run test - PASS. `npx nest build` clean.
- [ ] Step 6: commit `feat(connect/monetization): seed connect free + premium tiers/plans (M0.4)`.

## Task M0.5: ConnectAllowanceService

**Files:** Create `modules/connect/monetization/connect-allowance.service.ts` + `connect-monetization.module.ts`; Test `connect-allowance.service.vitest.ts`.

- [ ] Step 1 (discovery): read `modules/common/utils/entitlement-resolve.util.ts` + how `appliedEntitlements` is fetched per user, to reuse the resolver rather than re-querying.
- [ ] Step 2 (RED): tests for `getAllowances(userId)` (returns the connect sub-block of the user's active Connect subscription, or the Free defaults when none), `assertCanCreateListing(userId, currentCount)` (throws a 403-style error when `currentCount >= maxListings` and `maxListings !== -1`), `canUseLead(userId, usedThisCycle)`.
- [ ] Step 3: run - FAIL.
- [ ] Step 4 (GREEN): implement reading `appliedEntitlements.connect.*` (treat `-1` as unlimited). No workspace inheritance. Register the service + module; export it for M1 (marketplace) to consume.
- [ ] Step 5: run tests - PASS. `npx nest build` clean.
- [ ] Step 6: commit `feat(connect/monetization): ConnectAllowanceService (M0.5)`.

## Task M0.6: Included-credits grant cron

**Files:** Create `modules/connect/monetization/crons/included-credits-grant.cron.ts`; possibly extend `modules/connect/ads/services/wallet.service.ts` to distinguish granted vs purchased; Test `included-credits-grant.cron.vitest.ts`.

- [ ] Step 1 (discovery): read an existing billing cron (`modules/subscriptions/billing/crons/renewal-notice.cron.ts`) for the `@Cron` + IST/UTC pattern, and confirm `WalletService.topup(ownerUserId, amount, meta)` accepts an `idempotencyKey` + a ledger `type`.
- [ ] Step 2 (RED): test that for an active `connect` subscription with `includedBoostCredits > 0`, the cron grants exactly that many credits into the user's `AdvertiserWallet` once per cycle (idempotent on `grant-<subId>-<cycleStart>`), tagged as a GRANT (expiring), and a second run in the same cycle is a no-op.
- [ ] Step 3: run - FAIL.
- [ ] Step 4 (GREEN): implement. If the wallet ledger has no grant/expiry distinction yet, add a ledger `type: 'grant'` + an `expiresAt`/`grantBalance` field so a cycle-reset sweep can clear unused grants (purchased credits untouched). Keep the existing `topup` idempotency behavior.
- [ ] Step 5: run tests - PASS. `npx nest build` clean.
- [ ] Step 6: commit `feat(connect/monetization): included-boost-credit grant cron (M0.6)`.

## Task M0.7: Admin - Connect plan/tier management

**Files:** Modify `modules/subscriptions/billing/services/admin-plan.service.ts` + the plan/tier admin DTO(s); web admin `app/admin/plans` + `app/admin/tiers` (add a `product` selector + the connect entitlement fields). Test backend `admin-plan.connect.vitest.ts`.

- [ ] Step 1 (discovery): read `admin-plan.service.ts` + its create/update DTO to confirm entitlements pass through as a structured object (investigation says `entitlements?: Record<string, unknown>` passes straight through).
- [ ] Step 2 (RED): test that the admin create-plan path accepts `product: 'connect'` + a `connect` entitlements block and persists them; that listing plans can be filtered by `product`.
- [ ] Step 3: run - FAIL (DTO rejects `product`).
- [ ] Step 4 (GREEN): add `product` to the create/update DTO (enum, default `erp`) + a `product` filter on the admin list endpoint. Ensure audit logging tags the Connect plan writes.
- [ ] Step 5: web admin - add a `product` selector to the plan/tier forms + the connect allowance fields (reuse the existing dynamic entitlement form; the values pass through). Verify the admin can create a Connect plan end to end.
- [ ] Step 6: `npx nest build` clean + web eslint/tsc on touched files. Commit `feat(connect/monetization): admin connect plan/tier management (M0.7)`.

## Task M0.8: Back-fill migration (RISK #3)

**Files:** Create `scripts/migrations/2026-05-27-backfill-product-erp.ts`; Test `__tests__/backfill-product.vitest.ts`.

- [ ] Step 1 (RED): test that the migration sets `product: 'erp'` on every existing `Plan` + `Subscription` lacking it, and is idempotent (re-run = no further writes).
- [ ] Step 2: run - FAIL.
- [ ] Step 3 (GREEN): write the migration (modeled on the existing strip/migration scripts). Also back-fill any new Connect sub-feature keys onto existing ACTIVE subscriptions if absent, so the guard never reads them as LOCKED (per risk #3). ERP subs are unaffected (they already have all ERP keys).
- [ ] Step 4: run test - PASS.
- [ ] Step 5: commit `chore(connect/monetization): back-fill product + connect keys migration (M0.8, risk-3)`.

---

## Verify battery (per task)

- Typecheck: `npx nest build` (SWC). NEVER whole-project tsc.
- Tests: `npx vitest run <file> --no-file-parallelism`.
- Lint: `npx eslint <changed files>` (fix ERROR-level; no-unsafe/no-explicit-any are allowed warnings).
- DI: confirm the new module wires into the app module graph.

## Self-Review (spec coverage)

- Separate Connect plans -> M0.1 (product) + M0.4 (seed). Separate wallet -> reuses ads `AdvertiserWallet` (M0.6 grants into it). Person-centric -> M0.2 + M0.5 (no workspace inheritance). Dynamic/admin -> M0.7. Feature-by-feature -> the `connect` sub-block + moduleAccess keys. Free-now/paid-later -> entitlement values are data (M0.4 generous free) + the entitlements layer (existing). The 3 risks -> M0.2 / M0.3 / M0.8 explicitly.
- Out of scope for M0 (later phases): listings + search + leads (M1), boost-a-listing + ad rail + paid-leads metering (M2), the consolidated admin console + promotions/sales UI (M3). M0 ships dormant + free; nothing user-facing changes.

## Execution Handoff

Two options: (1) Subagent-Driven (fresh subagent per task + 2-stage review) - NOTE: subagents have stream-truncated repeatedly this session, so (2) Inline execution with the per-task verify battery may be more reliable. Owner picks. No execution until owner approves this plan.
