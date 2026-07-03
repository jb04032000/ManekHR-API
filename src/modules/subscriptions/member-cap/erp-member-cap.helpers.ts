/**
 * Pure, side-effect-free helpers for the ERP member-cap feature. Unit-tested in
 * isolation (no Nest / no Mongo). Mirrors the Connect over-limit helpers
 * (`computeSuppressedIds` / `graceElapsed`) but expresses the cap as an ALLOWED
 * set (owner-first, oldest-survive) rather than a suppressed set.
 */

/** Plan entitlement sentinel for "no member cap". */
export const UNLIMITED = -1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The allowed member-id set under the cap. Owner is NEVER excluded.
 *
 * - `ownerMemberId`: the workspace OWNER's own TeamMember id, or null when the
 *   owner has no TeamMember record in this workspace.
 * - `otherMemberIdsOldestFirst`: every OTHER active member id, sorted by join
 *   date ASCENDING (oldest first). The owner must NOT appear in this list.
 * - `limit`: the plan's `maxMembersPerWorkspace` (-1 = UNLIMITED).
 *
 * Result = owner (if present) + the oldest `(limit - 1)` others. When the owner
 * is null we have no seat to reserve, so the result is the oldest `limit`
 * others. When `limit === UNLIMITED` everyone is returned (owner + all others).
 * The total length is always `<= limit` (or all members when unlimited).
 *
 * Does not mutate its inputs.
 */
export function computeAllowedMemberIds(
  ownerMemberId: string | null,
  otherMemberIdsOldestFirst: string[],
  limit: number,
): string[] {
  // UNLIMITED → everyone survives, owner first for a stable ordering.
  if (limit === UNLIMITED) {
    return ownerMemberId
      ? [ownerMemberId, ...otherMemberIdsOldestFirst]
      : [...otherMemberIdsOldestFirst];
  }

  // No owner record → no reserved seat; keep the oldest `limit` others.
  if (!ownerMemberId) {
    return otherMemberIdsOldestFirst.slice(0, Math.max(0, limit));
  }

  // Owner always occupies one seat. `limit - 1` others (oldest first) fill the
  // rest. `slice` clamps to the available others, so the result is never longer
  // than `limit` and never drops the owner (even at limit 1 → owner only).
  const otherSeats = Math.max(0, limit - 1);
  return [ownerMemberId, ...otherMemberIdsOldestFirst.slice(0, otherSeats)];
}

/**
 * Whether the over-cap grace window has fully elapsed (the cap may begin to
 * apply). Copied from the Connect `graceElapsed` exactly. Returns false when no
 * clock has been started (fair warning is guaranteed before any capping).
 */
export function graceElapsed(overCapSince: Date | null, graceDays: number, now: Date): boolean {
  if (!overCapSince) return false;
  const endsAt = overCapSince.getTime() + graceDays * MS_PER_DAY;
  return now.getTime() >= endsAt;
}
