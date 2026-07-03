import { Types } from 'mongoose';

/**
 * ManekHR Connect — shared keyset (compound) cursor helper.
 *
 * What it does: encodes/decodes an opaque pagination cursor that pins the last
 * row's `(createdAt, _id)` so the next page resumes EXACTLY after it, with a
 * stable `_id` tiebreak for rows that share a `createdAt` millisecond. This is
 * the feed's newest-first convention plus the tiebreak the feed's date-only
 * cursor lacks, so it is safe wherever two rows can land on the same timestamp
 * (high-volume comment threads, inquiry inboxes, job applications, RFQ quotes).
 *
 * Cross-module: used by the feed comment thread, marketplace inquiry inbox/outbox,
 * job applications, and RFQ quotes — every Connect list that grows with other
 * users' content. Keep the sort (`{ createdAt: -1, _id: -1 }`) and `keysetFilter`
 * in lock-step: the filter is only correct for that exact newest-first order.
 *
 * Watch: the cursor is opaque (base64url) but NOT signed — it only encodes a sort
 * position, never an authorization boundary, so each caller must still scope its
 * own query (by postId / ownerUserId / etc.). A malformed cursor decodes to
 * `null` and is treated as "first page" (lenient, like the feed's date cursor).
 */

/** A decoded keyset position — the last row's sort key. */
export interface KeysetCursor {
  createdAt: Date;
  id: Types.ObjectId;
}

/** A row carrying the sort key — what `.lean()` reads yield. */
export interface KeysetRow {
  _id: Types.ObjectId;
  createdAt: Date;
}

/** Encode a row's `(createdAt, _id)` into an opaque base64url cursor. */
export function encodeCursor(row: KeysetRow): string {
  const raw = `${row.createdAt.getTime()}|${row._id.toHexString()}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Decode a cursor back to its `(createdAt, _id)` position. Returns `null` for an
 * absent or malformed cursor (treated as the first page), so a bad client value
 * never throws — it just restarts paging.
 */
export function decodeCursor(cursor?: string | null): KeysetCursor | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep < 0) return null;
    const ms = Number(raw.slice(0, sep));
    const idHex = raw.slice(sep + 1);
    if (!Number.isFinite(ms) || !Types.ObjectId.isValid(idHex)) return null;
    return { createdAt: new Date(ms), id: new Types.ObjectId(idHex) };
  } catch {
    return null;
  }
}

/**
 * The Mongo filter clause selecting rows strictly AFTER the cursor under a
 * newest-first `{ createdAt: -1, _id: -1 }` sort. Spread into the scoped query
 * filter; returns `{}` for the first page. Top-level fields and this `$or` are
 * ANDed by Mongo, so the caller's scope (postId / ownerUserId / ...) still holds.
 */
export function keysetFilter(cursor: KeysetCursor | null): Record<string, unknown> {
  if (!cursor) return {};
  return {
    $or: [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ],
  };
}

/** Default page size for Connect keyset lists (matches the feed's page size). */
export const DEFAULT_PAGE_SIZE = 20;
/** Hard ceiling a client `limit` is clamped to across Connect keyset lists. */
export const MAX_PAGE_SIZE = 50;

/**
 * DoS backstop for Connect list endpoints that are NOT yet keyset-paginated but
 * grow with content (a job's applicants, an RFQ's quotes, a hub user's followers,
 * a seller's public catalogue). Set far above any realistic single-entity volume
 * so it never affects real usage or the FE features that read the full set (the
 * hiring funnel, the RFQ price-comparison bar); it only stops a pathological
 * payload / unbounded DB read. Endpoints that hit this in practice should graduate
 * to real keyset pagination (see the change-set report).
 */
export const LIST_HARD_CAP = 500;

/**
 * Clamp a requested page size into `[1, max]`, defaulting to 20. The DTO already
 * rejects out-of-range values with `@Min(1) @Max(50)`; this is the service-layer
 * backstop so a method called directly (tests, internal callers) is still bounded.
 */
export function clampPageSize(
  limit: number | undefined,
  max: number = MAX_PAGE_SIZE,
  fallback: number = DEFAULT_PAGE_SIZE,
): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/**
 * Shape one page from an over-fetched window: ask the query for `limit + 1` rows,
 * pass the result here, and get back the page plus the `nextCursor` (null when the
 * window was not full, i.e. no more rows). Centralises the has-more/encode logic
 * so every list endpoint computes the cursor identically.
 */
export function buildPage<T extends KeysetRow>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
