/**
 * Username-slug ("handle") utilities — single source of truth for the format
 * + reserved list + slugify algorithm. Used by `UsersService` + the backfill
 * migration + the public profile resolver.
 *
 * See `docs/connect/specs/2026-05-20-username-slug-design.md` for the rules.
 */

/**
 * Format regex — handle must:
 *  - start with a letter;
 *  - contain only `[a-z0-9-]`;
 *  - never have two consecutive hyphens (`--`);
 *  - end with a letter or digit (no trailing hyphen).
 *
 * Length is enforced separately so the regex stays readable.
 */
export const HANDLE_FORMAT_RE = /^[a-z](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;

export const HANDLE_MIN_LEN = 3;
export const HANDLE_MAX_LEN = 30;

/**
 * Static deny-list. Anything that conflicts with a route segment or a
 * functional namespace inside Connect or the broader app. Expand cautiously
 * — adding to this list does NOT retroactively invalidate already-claimed
 * handles (only fresh claims are checked).
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Routes / namespaces.
  'admin',
  'api',
  'auth',
  'account',
  'connect',
  'dashboard',
  'design-system',
  'me',
  'u',
  'system',
  // Connect modules.
  'feed',
  'network',
  'marketplace',
  'jobs',
  'companies',
  'inbox',
  'notifications',
  'profile',
  'settings',
  'search',
  'onboarding',
  'home',
  // Generic deny.
  'support',
  'help',
  'about',
  'privacy',
  'terms',
  'pricing',
  'erp',
  'zari360',
  'zari',
  'zari-360',
]);

/**
 * Validate handle format + reserved-list. Returns a discriminated union so
 * the caller knows WHY validation failed and can render the right inline
 * message. Length is enforced here too.
 */
export function validateHandleFormat(
  value: string,
): { ok: true } | { ok: false; reason: 'format' | 'reserved' } {
  if (typeof value !== 'string') return { ok: false, reason: 'format' };
  const v = value.trim();
  if (v.length < HANDLE_MIN_LEN || v.length > HANDLE_MAX_LEN) {
    return { ok: false, reason: 'format' };
  }
  if (!HANDLE_FORMAT_RE.test(v)) return { ok: false, reason: 'format' };
  if (RESERVED_HANDLES.has(v.toLowerCase())) return { ok: false, reason: 'reserved' };
  return { ok: true };
}

/**
 * Derive a base handle from a display name.
 *
 *  - `NFKD`-normalize + strip combining marks → folds Latin diacritics
 *    (`é → e`); Indic scripts that aren't decomposable become `-` placeholders
 *    via the next step.
 *  - Lowercase.
 *  - Replace runs of non-`[a-z0-9]` chars with `-`.
 *  - Trim leading / trailing hyphens.
 *  - Collapse `--` to `-`.
 *
 * May return an EMPTY string (e.g. for a pure-non-Latin name) — the caller
 * handles fallback (typically appending a short id suffix). Length is NOT
 * enforced here; the caller truncates after appending its own suffix.
 */
export function slugifyName(name: string): string {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip Latin combining marks (NFKD output)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
