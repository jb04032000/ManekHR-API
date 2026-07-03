import type { ConnectLimitKind } from '../monetization/connect-allowance.service';

/**
 * CN-LIM-3 — stable lock name for serializing a Connect creation cap's
 * check-then-insert critical section, scoped to ONE owner + ONE kind.
 *
 * Every countable creation path (listing / job / storefront / company_page) does
 * `count -> assertCap -> insert`, which is a TOCTOU race under concurrency: two
 * requests at limit-1 can both read the same count, both pass the assert, and
 * both insert (landing at limit+1). Wrapping each critical section in
 * `SingleFlightService.withLock(connectCapLockKey(kind, ownerId), ...)` makes the
 * read+insert atomic PER OWNER PER KIND, so:
 *   - two of the SAME owner+kind creates run one-at-a-time (the second re-reads
 *     the now-incremented count and is correctly rejected at the cap), while
 *   - different owners, and different kinds for the same owner, never block each
 *     other (independent keys → no false contention on an unrelated create).
 *
 * The key uses the owner id string exactly as the caller passes it. Kept as a
 * tiny pure helper (no I/O) so all four call sites derive an identical,
 * non-colliding key from one source — no drift, trivially unit-testable.
 */
export function connectCapLockKey(kind: ConnectLimitKind, ownerUserId: string): string {
  return `connect:cap:${kind}:${ownerUserId}`;
}
