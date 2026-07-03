# ADR-0003: "People you may know" requires a live owning account (no ghost rows); deletion model unchanged

**Status:** Proposed
**Date:** 2026-06-17
**Deciders:** Owner (decided: fix the leak now; do NOT rebuild deletion/retention — the existing model stands)

## Context

The Connect Network "Suggestions" tab rendered rows labelled **"Connect member"**
with a generic avatar, no headline, and a working Connect button — sitting next to
fully-hydrated real people (e.g. "Meera Sharma"). The owner asked whether these are
deleted accounts and, if so, what the app should do about their data under the DPDP
act (delete now vs. retain for a window vs. build the "proper" thing).

Read-only investigation established the actual mechanics:

- **The "Connect member" label is the web placeholder** (`SuggestionsTab.tsx` ->
  `toConnectPerson(..., tPerson('fallbackName'))`). It renders only when a
  suggested `userId` is **absent** from the people-hydration index — i.e.
  `getPeopleByIds` returned no row for it. A still-present (even anonymized) User
  would hydrate as its name (e.g. "Deleted user"), not the fallback. So the id has
  **no live `User` row at all**.

- **The suggestion engine never joins `User`.** `SuggestionService.getSuggestions`
  builds its candidate pool from `ConnectProfile` alone (`visibility: 'public'`).
  A `ConnectProfile` can **outlive its owning `User`**: a hard-deleted account, or
  leftover **seeded-demo** data (`User.isDemo`; 18 demo personas per ADR-0002), can
  leave an **orphan profile** whose `userId` resolves to no `User`. That orphan id
  passes the suggestion filter, then fails hydration -> ghost row.

- **The proper DPDP deletion model already exists and is correct.**
  `AccountErasureService` (`docs/compliance/DATA-MAP-AND-RETENTION.md`,
  auth-hardening §3) implements _anonymize-don't-delete_: identity PII with no
  retention basis is scrubbed immediately (name -> "Deleted user", email/mobile/
  photo nulled, auth secrets cleared), statutory/billing data is retained under a
  recorded legal basis (8y GST/billing), the account is `isActive:false` +
  `deletedAt` + `connectEnabled:false`, every erasure is audited, and an
  `ACCOUNT_ERASED` event flips the Connect profile to `visibility:'hidden'` +
  de-indexes search. **A properly erased user is therefore already excluded from
  suggestions by the `visibility:'public'` filter** — so the ghost rows are NOT
  the output of a deletion awaiting a retention decision. They are orphaned/demo
  data: a data-integrity defect, not a missing privacy feature.

This reframes the owner's question: there is nothing new to build for DPDP
deletion. The fix is small and local to the suggestion path.

## Decision

1. **Add a live-owner guard to `SuggestionService.getSuggestions`.** After the
   candidate pool is assembled, drop any candidate whose owning `User` does not
   exist / is not active / is erased / is not Connect-enabled
   (`isActive: { $ne: false }`, `deletedAt: { $in: [null, undefined] }`,
   `connectEnabled: { $ne: false }`) via one indexed `$in` over the candidate
   ids. This mirrors the live-account contract the public profile read already
   enforces (`ConnectProfileService.getPublicByUserId` orphan guard).

2. **Leave the account-erasure / retention model unchanged.** The existing
   anonymize-don't-delete design is the DPDP approach; it is not touched.

3. **Existing orphaned rows are cleared by a ledgered migration** (0044, ADR-0001
   runner): a one-shot, idempotent purge of `connectprofiles` whose `userId` has
   no live `User`, plus the dangling first-degree graph edges (connections /
   requests / follows) that reference them. Demo _content_ (posts/listings/jobs)
   remains owned by the existing demo-purge tooling (`AdminConnectDemoService` /
   `scripts/connect-demo`, matched on `isDemo`); 0044 does not duplicate it. The
   guard already makes the symptom invisible; 0044 removes the stale data.

## Options Considered

### Option A: Backend live-owner guard in the suggestion engine (chosen)

| Dimension   | Assessment                                                 |
| ----------- | ---------------------------------------------------------- |
| Complexity  | Low — one `$in` query + a filter                           |
| Cost        | One extra indexed `_id` lookup per suggestions request     |
| Correctness | Fixes at the source; honours `limit` (filter before slice) |

**Pros:** Root-cause fix; no orphan/inactive id can be suggested again; matches the
existing public-read contract. **Cons:** A small added query.

### Option B: Web-side filter (drop unhydrated suggestions in `SuggestionsTab`)

**Pros:** Trivial. **Cons:** Defence-in-depth only, not the cause; silently masks
_any_ hydration miss, which could hide future real bugs. Rejected as the primary
fix (acceptable later as a thin secondary guard).

### Option C: Build a new deletion / retention system now

**Pros:** None — it already exists. **Cons:** Wasted effort; risks regressing a
working, audited, DPDP-correct model. Rejected.

## Trade-off Analysis

The cheapest correct fix is at the layer that _creates_ the bad ids (the suggestion
engine), not the layer that _displays_ them (web). Option A removes the class of
defect (orphan/inactive/erased suggestions) for one small query; Option B only
hides one symptom and could conceal others. The deletion model is out of scope —
the investigation proved the ghost rows are unrelated to it.

## Consequences

- **Easier:** Suggestions are guaranteed to point at reachable accounts; no
  "Connect member" placeholders.
- **Harder / watch:** The guard's liveness fields must stay in sync with
  `AccountErasureService` (`isActive` / `deletedAt` / `connectEnabled`). If a new
  "soft-disable" lifecycle state is added later, revisit this filter.
- **Revisit:** No self-service "delete my account" flow exists yet (erasure is
  admin-triggered only). DPDP expects a data-principal erasure _request_ path —
  tracked as a separate follow-up, not part of this change.

## Action Items

1. [x] Live-owner guard in `suggestion.service.ts` (+ `liveCandidateCount` span attr).
2. [x] Unit tests: orphan/non-live candidate dropped; guard query shape asserted;
       existing tests updated to supply a live owner.
3. [x] Migration `0044_connect_purge_orphan_profiles` (once, idempotent) +
       3 unit tests. Removes orphan profiles + dangling graph edges.
4. [ ] Owner: run `npm run migrate` (applies 0044) + smoke the Suggestions tab.
5. [ ] Backlog: self-service account-deletion request flow (DPDP data-principal right).
