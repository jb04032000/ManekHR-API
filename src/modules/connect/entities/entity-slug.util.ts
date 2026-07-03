import { slugifyName } from '../../users/utils/handle.util';

/** Slug length bound for an owned entity public URL (`/company/[slug]`, `/store/[slug]`). */
export const ENTITY_SLUG_MAX_LEN = 80;
const ENTITY_SLUG_MIN_LEN = 3;

/**
 * Derive a URL slug from a display name and make it unique against an existence
 * check. Reuses the shared `slugifyName` (NFKD fold, lowercase, hyphenate) so
 * the algorithm matches the user-handle slugifier. On collision it appends
 * `-2`, `-3`, ... A pure-non-Latin name slugifies to empty, so we fall back to
 * a generic base and let the uniqueness loop disambiguate.
 *
 * `exists(slug)` returns true when the slug is already taken (per collection).
 */
export async function generateUniqueEntitySlug(
  name: string,
  exists: (slug: string) => Promise<boolean>,
  fallbackBase = 'page',
): Promise<string> {
  let base = slugifyName(name).slice(0, ENTITY_SLUG_MAX_LEN);
  if (base.length < ENTITY_SLUG_MIN_LEN) {
    base = base ? `${base}-${fallbackBase}` : fallbackBase;
  }

  let candidate = base;
  let n = 1;
  // Bounded by the existence check; practical collisions are tiny.
  while (await exists(candidate)) {
    n += 1;
    const suffix = `-${n}`;
    candidate = `${base.slice(0, ENTITY_SLUG_MAX_LEN - suffix.length)}${suffix}`;
  }
  return candidate;
}
