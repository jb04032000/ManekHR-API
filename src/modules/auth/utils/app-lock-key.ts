/**
 * App-Lock Redis key builder.
 *
 * App-Lock unlock + setup-grace state is keyed to the per-login `family`
 * claim, NOT the access-token `jti`. A token refresh rotates the `jti` but
 * preserves the `family`; the browser-side and cookie-side token chains both
 * descend from one login and share the `family`. Keying on `family` is what
 * lets a PIN unlock survive a refresh and be seen by server components.
 *
 * `jti` is the fallback for legacy tokens minted before the `family` claim
 * existed. Those age out within the 7-day refresh-token TTL.
 */
export type AppLockIds = { family?: string | null; jti?: string | null };

export function appLockKey(prefix: 'unlocked' | 'setup-grace', ids: AppLockIds): string | null {
  if (ids.family) return `${prefix}:fam:${ids.family}`;
  if (ids.jti) return `${prefix}:jti:${ids.jti}`;
  return null;
}
