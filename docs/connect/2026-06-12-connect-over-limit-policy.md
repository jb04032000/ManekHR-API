# Connect over-limit (grandfathering) policy

Date: 2026-06-12
Status: implemented (uncommitted)

## Problem

Creation-path limit enforcement is live (count >= limit blocks creation). A user
can BE over a limit (items predating a limit drop, or after an admin lowers their
override). Today that over-limit state is implicit — they're just blocked from
creating. We make it an explicit, surfaced, policy-driven state:

- **freeze** (default): existing items stay live forever; creation stays blocked;
  nothing else changes. Exactly today's behavior, made visible.
- **hide_newest** (opt-in per plan): after a grace period, the NEWEST items beyond
  the limit are suppressed from public surfaces but stay fully visible + editable
  to the owner with a "suppressed" badge. Nothing is ever deleted. Reversible.

## Key design decisions

### 1. Suppression is COMPUTED at read time (not a stored flag)

Two options were on the table: (a) compute the suppressed set at read time, or (b)
maintain a `suppressed` boolean on each item via a nightly job.

**Chosen: computed at read time.** Reasons:

- The requirements demand _instant_ reversal: "deleting an item un-suppresses the
  next one automatically" and "re-upgrade instantly un-suppresses everything." A
  stored flag maintained nightly cannot satisfy "instant" without recomputing on
  every item mutation and every plan/override change — exactly the fragile listener
  web the spec warns against ("Detection is COMPUTED, not event-driven... no
  fragile listeners on plan changes").
- A stored flag CAN drift (item created/deleted/limit-changed between cron runs →
  stale flag). A computed set is drift-free by construction: every read derives the
  set from current live state (current limit + current item ordering). Delete and
  re-upgrade are reflected on the very next read with zero extra machinery.

The suppressed set for `(owner, kind)` = the newest `(count - limit)` slot-occupying
items ordered `createdAt desc`, i.e. the OLDEST `limit` items survive (the seller
keeps their established items; the excess they added beyond plan is hidden). Only
applies when policy = `hide_newest`, limit != -1, count > limit, and the grace
period has elapsed.

### 2. Only the grace clock + notification episode are persisted

`ConnectOverLimitState` — one doc per `(userId, kind)` — stores:

- `overLimitSince`: when the current over-limit episode began (null when under).
- `notifiedAt`: when the entry notification was sent for the current episode.

This is small _episodic_ state, convergently maintained (idempotent upsert). It is
NOT the suppressed set (which is always computed). The clock resets to null the
moment usage returns under the limit (episode ends), so a later over-limit is a
fresh episode and re-notifies once.

`graceEndsAt = overLimitSince + graceDays`. Suppression only kicks in after this.

### 3. Reconciliation runs lazily AND nightly

- **Lazily:** `GET /me/connect/usage` reconciles the caller's state on every read
  (sets/clears `overLimitSince`, fires the once-per-episode notification). Active
  users get immediate, accurate state.
- **Nightly cron** (`connect.over_limit_reconcile`): iterates every owner of a
  Connect item and reconciles, so _passive_ users (who never open the usage
  surface) still get the grace clock started and the fair-warning notification on
  time. Reuses the scheduler-contract conventions (worker-role gate + Redis
  single-flight + idempotent convergent writes). The cron does NOT write any
  suppression flag — suppression stays read-time.

### 4. Search index is NOT touched by suppression

Meili index sync is event-driven on item change. Suppression is computed and can
change without an item event (limit drop, delete of a sibling), so baking it into
the index would reintroduce drift. Instead, search results are POST-FILTERED
through the suppression service at query time. The index stays drift-free re:
suppression; correctness is guaranteed by the post-filter.

### 5. Default is freeze everywhere — read paths are no-ops under default config

No plan ships `hide_newest`. Under the default `freeze` policy the suppression
service short-circuits to an empty set after a single cheap allowance read, so
every injected public-read filter is a behavior-preserving pass-through. `freeze`
public behavior is byte-identical to today; only the explicit state is surfaced.

## Surfaced shape

`ConnectUsageRow` gains: `overLimit`, `policy`, `graceDays`, `overLimitSince`,
`graceEndsAt`, `suppressionActive`, `suppressedCount`.

## Analytics

`connect.limit.over_limit_entered { kind, policy }` — fired web-side via the typed
catalog when the client first observes a new over-limit episode for a kind
(session-guarded by `overLimitSince`), approximating the server-authoritative
"entered" transition that drives the once-per-episode notification.

## Notification

One Connect notification per `(user, kind, episode)` via the existing notifications
module, category `connect.over_limit`. freeze wording: "You have {used} of {limit}
{kind} — existing items stay live; you can't add more." hide_newest wording adds the
grace deadline. No email in this pass (no email channel is wired for Connect; the
delivery settings persist email as inert — follow-up if/when an email channel ships).

## Admin

`app/admin/plans` exposes `overLimitPolicy` (Select freeze | hide_newest) and
`overLimitGraceDays` (number, default 30) on the Connect entitlements block.
