/**
 * Gujarati -> Latin transliteration for Connect search (SRCH-I18N-1).
 *
 * Pure, dependency-free, deterministic (no ML, no Nest, no Mongoose) so it
 * unit-tests in isolation — same posture as `query-understanding.ts` and the
 * textile dictionary.
 *
 * **Why a romanizer, not a second synonym table.** The textile synonym
 * dictionary is already Latin/Romanized (`saree` ⇄ `sadi`, `zari` ⇄ `jari`).
 * The only gap the verification checklist (§4 / AC-4.1) flags is *script*: a
 * member who types `સાડી` never reaches `sadi`. Romanizing `સાડી` -> `sadi`
 * lets the EXISTING synonyms + Meili typo-tolerance do the rest, both at query
 * time (fold the romanized form into the search text) and at index time (a
 * non-displayed `romanized` field so a Latin query finds Gujarati-script
 * content). The scheme targets how karigars actually romanize (Gujlish), not
 * strict ISO-15919 — single Latin vowels (`ા`→`a`, `ી`→`i`) so the output
 * lands on the dictionary's spellings rather than `saadii`.
 *
 * NOTE: every Gujarati map key is quoted. The dependent vowel signs (matras) are
 * combining marks, which are not valid as bare (unquoted) object-literal keys —
 * quoting keeps both the esbuild (vitest) and SWC (build) parsers happy.
 */

/** Independent vowels (U+0A85..U+0A94). Single Latin vowel for search recall. */
const INDEPENDENT_VOWELS: Record<string, string> = {
  અ: 'a',
  આ: 'a',
  ઇ: 'i',
  ઈ: 'i',
  ઉ: 'u',
  ઊ: 'u',
  ઋ: 'ru',
  ઍ: 'e',
  એ: 'e',
  ઐ: 'ai',
  ઑ: 'o',
  ઓ: 'o',
  ઔ: 'au',
};

/** Consonants (U+0A95..U+0AB9). Each carries an inherent 'a' unless a matra or virama follows. */
const CONSONANTS: Record<string, string> = {
  ક: 'k',
  ખ: 'kh',
  ગ: 'g',
  ઘ: 'gh',
  ઙ: 'ng',
  ચ: 'ch',
  છ: 'chh',
  જ: 'j',
  ઝ: 'jh',
  ઞ: 'ny',
  ટ: 't',
  ઠ: 'th',
  ડ: 'd',
  ઢ: 'dh',
  ણ: 'n',
  ત: 't',
  થ: 'th',
  દ: 'd',
  ધ: 'dh',
  ન: 'n',
  પ: 'p',
  ફ: 'ph',
  બ: 'b',
  ભ: 'bh',
  મ: 'm',
  ય: 'y',
  ર: 'r',
  લ: 'l',
  ળ: 'l',
  વ: 'v',
  શ: 'sh',
  ષ: 'sh',
  સ: 's',
  હ: 'h',
};

/** Dependent vowel signs / matras (U+0ABE..U+0ACC). They REPLACE the consonant's inherent 'a'. */
const MATRAS: Record<string, string> = {
  'ા': 'a',
  'િ': 'i',
  'ી': 'i',
  'ુ': 'u',
  'ૂ': 'u',
  'ૃ': 'ru',
  'ૅ': 'e',
  'ે': 'e',
  'ૈ': 'ai',
  'ૉ': 'o',
  'ો': 'o',
  'ૌ': 'au',
};

/** Gujarati digits U+0AE6..U+0AEF -> 0..9. */
const DIGITS: Record<string, string> = {
  '૦': '0',
  '૧': '1',
  '૨': '2',
  '૩': '3',
  '૪': '4',
  '૫': '5',
  '૬': '6',
  '૭': '7',
  '૮': '8',
  '૯': '9',
};

const VIRAMA = '્'; // halant — suppresses the inherent vowel (consonant cluster).
const ANUSVARA = 'ં'; // nasal -> 'n'
const CHANDRABINDU = 'ઁ'; // nasal -> 'n'
const VISARGA = 'ઃ'; // -> 'h'

/** Matches any character in the Gujarati Unicode block (U+0A80..U+0AFF). */
const GUJARATI_RANGE = /[઀-૿]/;

/** True when the string contains any character in the Gujarati Unicode block. */
export function hasGujarati(text: string): boolean {
  return GUJARATI_RANGE.test(text);
}

/**
 * Transliterate Gujarati script to a Latin (Gujlish) approximation. Any
 * non-Gujarati character (Latin letters, spaces, punctuation, digits) passes
 * through unchanged, so the function is safe to run on mixed or pure-Latin
 * input and is idempotent on already-romanized text.
 */
export function gujaratiToLatin(input: string): string {
  const chars = [...input];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];

    const consonant = CONSONANTS[c];
    if (consonant !== undefined) {
      const next = chars[i + 1];
      if (next !== undefined && MATRAS[next] !== undefined) {
        out += consonant + MATRAS[next];
        i += 1; // the matra is consumed with its consonant
      } else if (next === VIRAMA) {
        out += consonant; // virama suppresses the inherent vowel
        i += 1;
      } else {
        out += consonant + 'a'; // inherent vowel
      }
      continue;
    }

    const vowel = INDEPENDENT_VOWELS[c];
    if (vowel !== undefined) {
      out += vowel;
      continue;
    }

    const digit = DIGITS[c];
    if (digit !== undefined) {
      out += digit;
      continue;
    }

    if (c === ANUSVARA || c === CHANDRABINDU) {
      out += 'n';
      continue;
    }
    if (c === VISARGA) {
      out += 'h';
      continue;
    }
    // A stray matra / virama with no preceding consonant, plus the nukta /
    // avagraha and any other unmapped Gujarati codepoint, carry no standalone
    // Latin value — drop them. Everything else (Latin, whitespace, punctuation)
    // passes through verbatim.
    if (MATRAS[c] !== undefined || c === VIRAMA || GUJARATI_RANGE.test(c)) {
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Build the per-document `romanized` recall field (SRCH-I18N-1) from a doc's
 * searchable text parts (strings and/or string arrays). Flattens, drops empties,
 * and romanizes ONLY the Gujarati-script tokens — so an all-Latin document
 * yields `''` (no index bloat) and a Gujarati-script document yields its Latin
 * forms, letting a Latin query (and the textile synonyms) reach it.
 */
export function romanizedIndexField(...parts: Array<string | string[] | null | undefined>): string {
  const text = parts
    .flat()
    .filter((p): p is string => Boolean(p))
    .join(' ');
  return romanizeGujaratiTokens(text).join(' ');
}

/**
 * Romanize ONLY the whitespace-delimited tokens that contain Gujarati script,
 * returning their Latin forms (de-duplicated, first-seen order). A pure-Latin
 * input yields `[]`. Used to ADD romanized variants — at query time (fold into
 * the search text) and at index time (the `romanized` recall field) — without
 * disturbing the original tokens.
 */
export function romanizeGujaratiTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (!token || !hasGujarati(token)) continue;
    const latin = gujaratiToLatin(token).trim();
    if (latin && !seen.has(latin)) {
      seen.add(latin);
      out.push(latin);
    }
  }
  return out;
}
