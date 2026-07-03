/**
 * Pure place-name helpers for company-page locations. Kept standalone (no
 * Mongoose / env imports) so they unit-test in isolation, mirroring
 * `company-page-browse.helpers.ts`.
 */

/**
 * Normalize a place token (district / city): collapse internal whitespace and
 * trim. The first step in stopping free-text fragmentation of the directory
 * location facets ("  Surat  City " -> "Surat City").
 */
export function normalizePlace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
