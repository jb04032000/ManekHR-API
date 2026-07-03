/**
 * Textile + embroidery synonym dictionary for Indian textile-SMB search
 * (ManekHR Connect, S1.1). Each group lists trade terms treated as equivalent,
 * so a search for one surfaces them all (searching "zari" also finds
 * "zardozi"). Hindi / Gujarati workshop words sit beside their English
 * equivalents because that is how karigars and owners actually search.
 *
 * Pure data + pure helpers (no Nest, no Mongoose) so the registry and the unit
 * spec import them without the decorator-metadata pipeline.
 *
 * Synonyms are ADDITIVE recall only. They never gate a direct content match,
 * and the set GROWS at provisioning time when S1.3 merges ConnectTag.aliases
 * via {@link mergeSynonymMaps}.
 */

export type TextileTermCategory = 'material' | 'technique' | 'process' | 'product';

export interface SynonymGroup {
  /** Stable group label (the canonical trade term). For debugging and docs. */
  readonly canonical: string;
  /** Equivalent terms, lowercase. A search for any one expands to the rest. */
  readonly terms: readonly string[];
  /** Coarse grouping, for documentation and future facet hints. */
  readonly category: TextileTermCategory;
}

/** The curated seed. Extend freely; the unit spec guards the shape. */
export const TEXTILE_SYNONYM_GROUPS: readonly SynonymGroup[] = [
  // Materials
  { canonical: 'zari', category: 'material', terms: ['zari', 'zardozi', 'zardosi', 'jari'] },
  { canonical: 'moti', category: 'material', terms: ['moti', 'beads', 'pearl', 'pearls'] },
  { canonical: 'kundan', category: 'material', terms: ['kundan', 'kundun'] },
  { canonical: 'sitara', category: 'material', terms: ['sitara', 'sitare', 'sequins', 'sequin'] },
  {
    canonical: 'resham',
    category: 'material',
    terms: ['resham', 'reshmi', 'silk thread', 'silk-thread'],
  },
  { canonical: 'dabka', category: 'material', terms: ['dabka', 'dabaka', 'nakshi'] },
  {
    canonical: 'gota',
    category: 'material',
    terms: ['gota', 'gota patti', 'gota-patti', 'gotapatti'],
  },
  { canonical: 'mukaish', category: 'material', terms: ['mukaish', 'mukesh', 'badla'] },
  { canonical: 'tilla', category: 'material', terms: ['tilla', 'tila'] },
  {
    canonical: 'mirror work',
    category: 'material',
    terms: ['mirror work', 'mirror-work', 'sheesha', 'shisha', 'abhla'],
  },
  { canonical: 'thread', category: 'material', terms: ['thread', 'dhaga', 'dhaaga'] },
  { canonical: 'fabric', category: 'material', terms: ['fabric', 'cloth', 'kapda', 'kapada'] },
  // Techniques
  {
    canonical: 'embroidery',
    category: 'technique',
    terms: ['embroidery', 'bharatkaam', 'bharat kaam', 'kasida', 'kashida'],
  },
  {
    canonical: 'aari',
    category: 'technique',
    terms: ['aari', 'aari work', 'maggam', 'maggam work'],
  },
  {
    canonical: 'chikankari',
    category: 'technique',
    terms: ['chikankari', 'chikan', 'chikan work'],
  },
  { canonical: 'phulkari', category: 'technique', terms: ['phulkari', 'phulkaari'] },
  { canonical: 'weaving', category: 'technique', terms: ['weaving', 'bunai', 'bunkar', 'weaver'] },
  // Processes
  { canonical: 'dyeing', category: 'process', terms: ['dyeing', 'rangai', 'rangaai', 'dyer'] },
  {
    canonical: 'printing',
    category: 'process',
    terms: ['printing', 'chhapai', 'chapai', 'block print', 'block-print'],
  },
  // Products
  { canonical: 'saree', category: 'product', terms: ['saree', 'sari', 'sarees', 'sadi'] },
  { canonical: 'dupatta', category: 'product', terms: ['dupatta', 'odhni', 'chunni', 'chunari'] },
  {
    canonical: 'lehenga',
    category: 'product',
    terms: ['lehenga', 'lehnga', 'lehanga', 'ghagra', 'chaniya'],
  },
  { canonical: 'blouse', category: 'product', terms: ['blouse', 'choli'] },
];

/** Collapse the accumulator into the Meilisearch `synonyms` shape (sorted, de-duped). */
function finalizeSynonymAccumulator(
  accumulator: Map<string, Set<string>>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [term, peers] of accumulator) {
    result[term] = [...peers].sort();
  }
  return result;
}

/**
 * Expand synonym groups into the Meilisearch `synonyms` shape: every term maps
 * to its group peers (lowercase, de-duplicated, sorted), bidirectionally. A
 * term that appears in more than one group accumulates every association.
 */
export function buildSynonymMap(groups: readonly SynonymGroup[]): Record<string, string[]> {
  const accumulator = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const rawTerm of group.terms) {
      const term = rawTerm.toLowerCase();
      let peers = accumulator.get(term);
      if (!peers) {
        peers = new Set<string>();
        accumulator.set(term, peers);
      }
      for (const rawPeer of group.terms) {
        const peer = rawPeer.toLowerCase();
        if (peer !== term) peers.add(peer);
      }
    }
  }
  return finalizeSynonymAccumulator(accumulator);
}

/**
 * Merge synonym maps additively: the union of every association, de-duplicated.
 * This is the growth seam. The curated seed plus, later, ConnectTag.aliases
 * (S1.3) compose here, so newly learned vocabulary EXTENDS recall and never
 * removes a seeded association. That is the owner's guarantee that terms we
 * never anticipated are still findable, proven by the unit spec.
 */
export function mergeSynonymMaps(
  ...maps: ReadonlyArray<Record<string, readonly string[]>>
): Record<string, string[]> {
  const accumulator = new Map<string, Set<string>>();
  for (const map of maps) {
    for (const [rawKey, values] of Object.entries(map)) {
      const key = rawKey.toLowerCase();
      let peers = accumulator.get(key);
      if (!peers) {
        peers = new Set<string>();
        accumulator.set(key, peers);
      }
      for (const value of values) peers.add(value.toLowerCase());
    }
  }
  return finalizeSynonymAccumulator(accumulator);
}
