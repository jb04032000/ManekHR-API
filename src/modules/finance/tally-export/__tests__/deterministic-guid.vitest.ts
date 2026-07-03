import { describe, it, expect } from 'vitest';
import { deriveTallyGuid, TALLY_NAMESPACE_UUID } from '../utils/deterministic-guid';

describe('deriveTallyGuid (D-02 — Tally re-import idempotency)', () => {
  it('is deterministic — same Mongo _id produces identical GUID across two calls', () => {
    const a = deriveTallyGuid('507f1f77bcf86cd799439011');
    const b = deriveTallyGuid('507f1f77bcf86cd799439011');
    expect(a).toBe(b);
  });

  it('produces different GUIDs for different Mongo _ids', () => {
    const a = deriveTallyGuid('507f1f77bcf86cd799439011');
    const b = deriveTallyGuid('507f1f77bcf86cd799439012');
    expect(a).not.toBe(b);
  });

  it('is a syntactically valid UUID (8-4-4-4-12 hex format)', () => {
    const g = deriveTallyGuid('507f1f77bcf86cd799439011');
    expect(g).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('encodes UUID version 5 in the version nibble (top of 13th hex char)', () => {
    const g = deriveTallyGuid('507f1f77bcf86cd799439011');
    // Format: xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx — M = version
    expect(g.charAt(14)).toBe('5');
  });

  it('encodes RFC-4122 variant in the variant nibble (top 2 bits of 17th hex char are 10)', () => {
    const g = deriveTallyGuid('507f1f77bcf86cd799439011');
    const variantChar = g.charAt(19); // should be 8, 9, a or b
    expect(['8', '9', 'a', 'b']).toContain(variantChar);
  });

  it('exposes the standard RFC-4122 OID namespace as TALLY_NAMESPACE_UUID', () => {
    expect(TALLY_NAMESPACE_UUID).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
  });
});
