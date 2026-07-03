import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import {
  encodeCursor,
  decodeCursor,
  keysetFilter,
  clampPageSize,
  buildPage,
} from '../keyset-cursor';

/**
 * Unit coverage for the shared keyset cursor helper — the compound (createdAt,
 * _id) pagination used by every Connect list that grows with other users'
 * content (comments, inquiries, job applications, RFQ quotes).
 */
describe('keyset-cursor', () => {
  it('round-trips a row through encode/decode', () => {
    const row = { _id: new Types.ObjectId(), createdAt: new Date('2026-06-11T10:00:00.000Z') };
    const decoded = decodeCursor(encodeCursor(row));
    expect(decoded).not.toBeNull();
    expect(decoded.createdAt.getTime()).toBe(row.createdAt.getTime());
    expect(decoded.id.equals(row._id)).toBe(true);
  });

  it('decodes absent / malformed cursors to null (first page)', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64-$$$')).toBeNull();
    // base64url of a string with no separator / bad id.
    expect(decodeCursor(Buffer.from('garbage', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('123|notanid', 'utf8').toString('base64url'))).toBeNull();
  });

  it('builds the strictly-after filter with an _id tiebreak', () => {
    expect(keysetFilter(null)).toEqual({});
    const cur = { createdAt: new Date('2026-06-11T10:00:00.000Z'), id: new Types.ObjectId() };
    const f = keysetFilter(cur) as { $or: Array<Record<string, unknown>> };
    expect(f.$or).toHaveLength(2);
    expect(f.$or[0]).toEqual({ createdAt: { $lt: cur.createdAt } });
    expect(f.$or[1]).toEqual({ createdAt: cur.createdAt, _id: { $lt: cur.id } });
  });

  it('clamps the page size into [1, 50] with a default of 20', () => {
    expect(clampPageSize(undefined)).toBe(20);
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
    expect(clampPageSize(10)).toBe(10);
    expect(clampPageSize(50)).toBe(50);
    expect(clampPageSize(500)).toBe(50);
    expect(clampPageSize(7.9)).toBe(7);
    expect(clampPageSize(undefined, 30)).toBe(20);
    expect(clampPageSize(99, 30)).toBe(30);
  });

  it('buildPage detects more rows and emits a cursor only when the window is full', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      _id: new Types.ObjectId(),
      createdAt: new Date(2026, 0, i + 1),
    }));
    // Over-fetch returned limit+1 rows -> there IS a next page; last shown row
    // (index limit-1) drives the cursor.
    const full = buildPage(rows, 2);
    expect(full.items).toHaveLength(2);
    expect(full.nextCursor).toBe(encodeCursor(rows[1]));

    // Window not full -> caught up, null cursor.
    const tail = buildPage(rows, 5);
    expect(tail.items).toHaveLength(3);
    expect(tail.nextCursor).toBeNull();

    // Empty page -> null cursor.
    expect(buildPage([], 5).nextCursor).toBeNull();
  });
});
