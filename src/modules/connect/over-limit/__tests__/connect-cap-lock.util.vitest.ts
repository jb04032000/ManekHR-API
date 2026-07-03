import { describe, it, expect } from 'vitest';
import { connectCapLockKey } from '../connect-cap-lock.util';

/**
 * CN-LIM-3 — the shared per-owner-per-kind lock name used to serialize each
 * Connect creation cap's check+insert. The critical property is ISOLATION: the
 * key must be identical for the same (kind, owner) — so two of the same create
 * serialize — but distinct for a different owner OR a different kind — so
 * unrelated creates never falsely contend.
 */
describe('connectCapLockKey (CN-LIM-3)', () => {
  const OWNER_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const OWNER_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

  it('is stable for the same (kind, owner)', () => {
    expect(connectCapLockKey('listing', OWNER_A)).toBe(connectCapLockKey('listing', OWNER_A));
  });

  it('namespaces the key (collision-safe against other lock users of the mutex)', () => {
    expect(connectCapLockKey('listing', OWNER_A)).toBe(`connect:cap:listing:${OWNER_A}`);
  });

  it('differs by owner (owner A and owner B never block each other)', () => {
    expect(connectCapLockKey('listing', OWNER_A)).not.toBe(connectCapLockKey('listing', OWNER_B));
  });

  it('differs by kind (a listing create and a job create for the same owner never block each other)', () => {
    const kinds = ['listing', 'storefront', 'company_page', 'job'] as const;
    const keys = kinds.map((k) => connectCapLockKey(k, OWNER_A));
    // All four kind-keys for one owner are pairwise distinct.
    expect(new Set(keys).size).toBe(kinds.length);
  });
});
