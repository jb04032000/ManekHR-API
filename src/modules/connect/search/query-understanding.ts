/**
 * Pure, rule-based Query-Understanding for Connect search (S1.5). No Nest, no
 * Mongoose, no ML — so it unit-tests in isolation and the behaviour is fully
 * deterministic. It does three small, explainable things:
 *
 *  1. Strips the `#` marker from hashtags while KEEPING the bare word in the
 *     search text, so a `#zari` query still full-text matches "zari" content.
 *  2. Extracts the hashtags (lowercased, de-duplicated) for the service to
 *     resolve alias -> canonical slug via the tag taxonomy.
 *  3. Detects a small, curated set of unambiguous intent phrases (only
 *     multi-word, to avoid false positives) into facet filters, removing the
 *     phrase from the text so it does not pollute the relevance match.
 *
 * Growth path: more intent phrases are a one-line edit to the tables below;
 * vertical routing (jobs / listings) joins when those verticals go live. The
 * function is intentionally conservative — recall is never gated, only nudged.
 */
import type { PeopleSearchFilters } from './people-search.helpers';
import { romanizeGujaratiTokens } from './transliteration';

/** The structured reading of a raw search query. */
export interface UnderstoodQuery {
  /** The original query, untouched (for telemetry + echo). */
  raw: string;
  /** Lowercased search text: `#` markers removed, intent phrases stripped, words de-duplicated. */
  text: string;
  /** Hashtags found in the query (without `#`), lowercased + de-duplicated. */
  hashtags: string[];
  /** Facets inferred from intent phrases. Additive — only ever narrows on an explicit signal. */
  facets: PeopleSearchFilters;
}

/**
 * Multi-word phrases that signal "open to work". Multi-word on purpose: a bare
 * "available" or "work" is too ambiguous to flip a facet, so we never do.
 */
const OPEN_TO_WORK_PHRASES = [
  'open to work',
  'open for work',
  'looking for work',
  'available for work',
] as const;

/**
 * Unicode-aware hashtag matcher — Latin, Gujarati, Hindi, digits, underscore.
 * `\p{M}` (combining marks) is essential for Indic scripts: a Gujarati word
 * like "જરી" ends in a vowel sign (a Mark), which would otherwise truncate the
 * match and drop the character.
 */
const HASHTAG_RE = /#([\p{L}\p{N}\p{M}_]+)/gu;

/** De-duplicate while preserving first-seen order. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Parse a raw query into its structured reading. Pure and total: any string
 * (including `''`) yields a well-formed {@link UnderstoodQuery}.
 */
export function understandQuery(raw: string): UnderstoodQuery {
  const safeRaw = raw ?? '';
  const lowered = safeRaw.toLowerCase();

  // 1. Hashtags (unicode-aware), lowercased + de-duplicated.
  const hashtags = unique([...lowered.matchAll(HASHTAG_RE)].map((match) => match[1]));

  // 2. Drop the `#` markers but keep the words searchable.
  let working = lowered.replace(/#/g, ' ');

  // 3. Strip recognized intent phrases into facets.
  const facets: PeopleSearchFilters = {};
  for (const phrase of OPEN_TO_WORK_PHRASES) {
    if (working.includes(phrase)) {
      facets.openToWork = true;
      working = working.split(phrase).join(' ');
    }
  }

  // Collapse whitespace + de-duplicate words for a clean, minimal text term.
  const words = unique(working.split(/\s+/).filter(Boolean));

  // SRCH-I18N-1: fold the Latin romanization of any Gujarati-script token into
  // the search text, so a member who types `સાડી` also searches `sadi` — which
  // the `saree` synonym group already lists, reaching the same listings as the
  // English query. The original Gujarati tokens stay (so Gujarati-script content
  // still matches directly via the per-doc `romanized` index field); the
  // romanized variants are ADDITIVE recall only, never gating.
  const romanized = romanizeGujaratiTokens(words.join(' '));
  const text = unique([...words, ...romanized]).join(' ');

  return { raw: safeRaw, text, hashtags, facets };
}
