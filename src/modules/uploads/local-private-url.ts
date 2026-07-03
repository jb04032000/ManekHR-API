import { createHmac, timingSafeEqual } from 'crypto';

/**
 * LOCAL-DEV ONLY signed-URL helpers for private media. Production serves private
 * media via real R2 presigned URLs; this exists purely so the app runs without
 * R2 configured. The signature is an HMAC over `<key>:<exp>` so a dev private
 * file is reachable only with a fresh, unexpired token.
 *
 * Shared by `local-storage.service` (mint) and `uploads-private-dev.controller`
 * (verify) so the two can never drift on the signing scheme.
 */

/** Route the dev controller mounts the token-checked private stream on. */
export const LOCAL_PRIVATE_DEV_ROUTE = '/uploads/private-dev';

/** Signed link lifetime — mirrors the 1-hour R2 presign TTL. */
const TTL_SECONDS = 3600;

/** HMAC-SHA256 of `<key>:<exp>`, hex. */
function computeSig(key: string, exp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${key}:${exp}`).digest('hex');
}

/** Mint `{ exp, sig }` for a private object key (exp = unix seconds). */
export function signLocalPrivateKey(
  key: string,
  secret: string,
  nowMs: number = Date.now(),
): { exp: number; sig: string } {
  const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
  return { exp, sig: computeSig(key, exp, secret) };
}

/**
 * Verify a dev private-media token. Returns true only when the signature matches
 * (constant-time) AND the link has not expired. Pure — unit-testable without HTTP.
 */
export function verifyLocalPrivateToken(
  key: string,
  exp: number,
  sig: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!key || !Number.isFinite(exp) || !sig) return false;
  if (exp * 1000 < nowMs) return false; // expired
  const expected = computeSig(key, exp, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
