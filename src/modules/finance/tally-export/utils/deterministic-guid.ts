/**
 * Deterministic UUID v5 derivation for Tally voucher/master GUIDs (D-02).
 *
 * Re-running an export for the same Mongo `_id` MUST produce a byte-identical
 * `<GUID>` so Tally dedupes on re-import (overwrite semantics) instead of
 * creating duplicate vouchers.
 *
 * Implementation notes:
 *   - RFC 4122 §4.3: name-based UUID with SHA-1 hash (version 5).
 *   - Hand-rolled with Node `crypto` to avoid adding a `uuid` dependency to
 *     the backend (uuid is not declared in package.json; sub-deps not safe to
 *     rely on directly).
 *   - The namespace UUID below is the standard RFC-4122 example "OID"
 *     namespace — chosen as a stable, well-known constant. Treat it as
 *     part of the export contract: do NOT change without a migration plan
 *     (changing it makes every previously-exported voucher re-import as new).
 */
import { createHash } from 'crypto';

/**
 * Fixed namespace UUID used for all Tally GUID derivations.
 * RFC 4122 Appendix C "OID" namespace.
 */
export const TALLY_NAMESPACE_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidStringToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error(`Invalid namespace UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

function bytesToUuidString(b: Buffer): string {
  const hex = b.toString('hex');
  return (
    hex.substring(0, 8) +
    '-' +
    hex.substring(8, 12) +
    '-' +
    hex.substring(12, 16) +
    '-' +
    hex.substring(16, 20) +
    '-' +
    hex.substring(20, 32)
  );
}

/**
 * Derives a deterministic UUID v5 from a Mongo ObjectId hex string (or any
 * string identifier) using the Tally namespace.
 *
 * @example
 *   deriveTallyGuid('507f1f77bcf86cd799439011')
 *   // → 'cfdba1d4-9c43-5e7e-b6c5-d23e5d1c9c49' (stable across calls)
 */
export function deriveTallyGuid(mongoIdHex: string): string {
  const namespaceBytes = uuidStringToBytes(TALLY_NAMESPACE_UUID);
  const nameBytes = Buffer.from(mongoIdHex, 'utf8');

  const hash = createHash('sha1');
  hash.update(namespaceBytes);
  hash.update(nameBytes);
  const digest = hash.digest(); // 20 bytes

  const bytes = Buffer.alloc(16);
  digest.copy(bytes, 0, 0, 16);

  // Set UUID v5 — version (top nibble of byte 6) = 5; variant (top 2 bits of byte 8) = 10.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return bytesToUuidString(bytes);
}
