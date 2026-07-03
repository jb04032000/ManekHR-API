import type { MeiliIndexSettings } from './meili.client';
import { TEXTILE_SYNONYM_GROUPS, buildSynonymMap } from './dictionaries/textile-terms';

/**
 * Connect search index registry (S1.1).
 *
 * Every Connect search silo declares its Meilisearch settings here once:
 * people now, listings in M1.4, jobs in P5. Both provisioning
 * (`SearchService.reindexAllPeople` via `MeiliClient.ensureIndex`) and the
 * federated query layer (S1.5) read from this registry, so a new vertical
 * joins by adding one entry plus its document mapper, never a one-off.
 *
 * The settings convention is shared on purpose: typo-tolerance (Meili default),
 * the textile synonyms, and consistent searchable attributes apply to every
 * index identically.
 */

/**
 * The Meilisearch index holding searchable people documents. One document per
 * public `ConnectProfile`, keyed by `id` = the `User` id.
 */
export const CONNECT_PEOPLE_INDEX = 'connect_people';

/**
 * The Meilisearch index holding searchable marketplace listing documents
 * (M1.4). One document per `active` + `approved` `Listing`, keyed by `id` =
 * the `Listing._id`. Non-public listings (draft / pending / paused / rejected /
 * expired) are NOT in the index - the indexer purges them so search never
 * surfaces a non-public listing.
 */
export const CONNECT_LISTINGS_INDEX = 'connect_listings';

/**
 * The Meilisearch index holding searchable feed posts (search redesign Phase B).
 * One document per `public` + non-deleted + original (non-repost) `Post`, keyed
 * by `id` = the `Post._id`. Connections-only / soft-deleted / repost posts are
 * NOT in the index - the indexer purges them so search never surfaces a private
 * post or a duplicate of a reposted original.
 */
export const CONNECT_POSTS_INDEX = 'connect_posts';

/**
 * The Connect jobs index (Phase 5). Holds ONLY open jobs, keyed by `id` =
 * `Job._id`. The indexer purges closed / filled jobs so a no-longer-hiring job
 * never surfaces in search.
 */
export const CONNECT_JOBS_INDEX = 'connect_jobs';

/**
 * The Connect storefronts index (SRCH-VERT-1). Holds ONLY `public` storefronts
 * (shops), keyed by `id` = `Storefront._id`. The indexer purges any non-public
 * (`connections` / `hidden`) storefront so a draft / hidden shop never surfaces.
 * Owner-id is carried on the document (filterable) so the per-viewer block
 * filter + the author-active gate (a banned / erased owner's shop is dropped at
 * hydration) inherit exactly like listings.
 */
export const CONNECT_STOREFRONTS_INDEX = 'connect_storefronts';

/**
 * The Connect company / institute pages index (SRCH-VERT-1; owner-approved D1
 * name-search jump-to). Holds ONLY `public` `CompanyPage`s, keyed by `id` =
 * `CompanyPage._id`. The `kind` discriminator (`business` | `institute`) is a
 * filterable + displayed attribute so a search can narrow / label institutes vs
 * ordinary business pages. NOT a companies directory (owner decision: the
 * directory stays hidden) — this index powers name-search jump-to only. Same
 * owner-id-on-document gate inheritance as storefronts / listings.
 */
export const CONNECT_PAGES_INDEX = 'connect_pages';

/** One registered Connect search index: its uid plus the settings to provision. */
export interface ConnectSearchIndexDef {
  readonly uid: string;
  readonly settings: MeiliIndexSettings;
}

/**
 * SRCH-I18N-1: per-locale tokenizer hints, applied identically to every index.
 * Tells Meilisearch that any attribute may hold Gujarati / Hindi / English text
 * so its segmenter + normalizer handle the Indic scripts correctly. Paired with
 * the per-document `romanized` field (Gujarati->Latin) + the query-time
 * romanization in `query-understanding.ts`. NOTE: `localizedAttributes` needs
 * Meilisearch >= 1.10; an older engine rejects the settings PATCH, which
 * `MeiliClient` swallows (search still works, minus the locale hint).
 */
const LOCALIZED_ATTRIBUTES: MeiliIndexSettings['localizedAttributes'] = [
  { locales: ['guj', 'hin', 'eng'], attributePatterns: ['*'] },
];

const PEOPLE_INDEX_DEF: ConnectSearchIndexDef = {
  uid: CONNECT_PEOPLE_INDEX,
  settings: {
    // Order = ranking strength: a name hit outranks a headline hit, which
    // outranks a skill hit.
    // `services` appended last = lowest ranking weight (a name/headline/skill hit
    // outranks a services-title hit). Powers "Find a Service" free-text recall.
    // `romanized` (SRCH-I18N-1) appended LAST = lowest ranking weight: a Latin
    // query reaches Gujarati-script content without outranking a real name hit.
    // Not in displayedAttributes — it is a recall field, never rendered.
    searchableAttributes: ['name', 'headline', 'skills', 'services', 'romanized'],
    localizedAttributes: LOCALIZED_ATTRIBUTES,
    // demoRank (0 real / 1 demo) is displayed so the FE can read the sample
    // marker off a hit; the `demoRank:asc` ranking rule below uses it too.
    displayedAttributes: ['id', 'name', 'headline', 'skills', 'services', 'demoRank'],
    // Candidate facets (S1.2): filter by skill, district, open-to-work /
    // open-to-hiring, ERP-linked, providing-services; sort by experience.
    filterableAttributes: [
      'skills',
      'district',
      'openToWork',
      'openToHiring',
      'providingServices',
      'erpLinked',
      'experienceYears',
    ],
    // demoRank is sortable so the `demoRank:asc` ranking rule below is valid.
    sortableAttributes: ['experienceYears', 'demoRank'],
    // Custom ranking on top of the Meili defaults: exactness is built in, then
    // boost ERP-linked members (the Connect trust moat) and break ties by
    // experience. erpLinked / experienceYears are numeric so the rules are valid.
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'sort',
      'exactness',
      'erpLinked:desc',
      'experienceYears:desc',
      // Demo Content scope: seeded sample profiles sink to the bottom of an
      // otherwise-equal tie (demoRank 0 real < 1 demo). Appended LAST so a real
      // tie-break always wins above a demo, yet a demo still surfaces when it is
      // the only match (a down-rank, not an exclusion — mirrors demo-rank.ts).
      'demoRank:asc',
    ],
    // Textile synonyms are additive recall only. They never gate a direct
    // content match, and they grow: S1.3 merges ConnectTag.aliases via
    // mergeSynonymMaps before provisioning.
    synonyms: buildSynonymMap(TEXTILE_SYNONYM_GROUPS),
  },
};

const LISTINGS_INDEX_DEF: ConnectSearchIndexDef = {
  uid: CONNECT_LISTINGS_INDEX,
  settings: {
    // Title is the strongest ranking signal (a member who types "zari saree"
    // is looking for a saree first, not a description that happens to mention
    // both words). Description + category back it up.
    searchableAttributes: ['title', 'description', 'category', 'tags', 'romanized'],
    localizedAttributes: LOCALIZED_ATTRIBUTES,
    displayedAttributes: [
      'id',
      'title',
      'description',
      'category',
      'priceType',
      'priceMin',
      'priceMax',
      'unit',
      'district',
      'ownerUserId',
      'images',
      'tags',
      'verified',
      'searchPriority',
      'createdAt',
      // demoRank (0 real / 1 demo) displayed so the FE can read the sample marker.
      'demoRank',
    ],
    // Listing facets (M1.4): filter by category, district, price floor, the
    // canonical public gate (`active` + `approved`), the owner id (for the
    // my-listings -> public-view dual use), and the owner verified marker (the
    // "verified sellers only" buyer toggle). `verified` is a denormalized owner
    // signal (M2.3) on the document; listing it here lets the buyer toggle
    // filter on it server-side.
    filterableAttributes: [
      'category',
      'district',
      'priceMin',
      'priceMax',
      'status',
      'moderationStatus',
      'ownerUserId',
      'storefrontId',
      'tags',
      'verified',
    ],
    // Sort by price (cheapest first when the buyer cares), recency (newest first
    // by default tiebreak), or verified-first (the buyer sort dropdown). searchPriority
    // is sortable too so the paid ranking rule below is valid; `verified` is a
    // sortable boolean so the `verified:desc` user sort is valid.
    // demoRank is sortable so the `demoRank:asc` ranking rule below is valid.
    sortableAttributes: [
      'priceMin',
      'priceMax',
      'createdAt',
      'searchPriority',
      'verified',
      'demoRank',
    ],
    // Custom ranking on top of the Meili defaults. Same textile-relevance
    // shape as people, plus the paid `searchPriority` boost (M2.3) above a
    // recency tiebreak: once relevance/exactness tie, a higher-priority (paid)
    // seller outranks, and a fresher listing breaks any remaining tie. Both
    // searchPriority and createdAt are numeric on the document so the rules
    // are valid.
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'sort',
      'exactness',
      'searchPriority:desc',
      'createdAt:desc',
      // Demo Content scope: seeded sample listings sink below a real tie (see
      // people index note) — last rule, a down-rank not an exclusion.
      'demoRank:asc',
    ],
    // Same textile synonyms as people - a buyer typing "zardozi" or "moti"
    // hits the same canonical recall here. S1.3's ConnectTag.aliases merge
    // applies identically when the seed catches up.
    synonyms: buildSynonymMap(TEXTILE_SYNONYM_GROUPS),
  },
};

const POSTS_INDEX_DEF: ConnectSearchIndexDef = {
  uid: CONNECT_POSTS_INDEX,
  settings: {
    // Body is the primary signal; hashtags back it up so `#zari` matches a post
    // tagged zari even when the word is not in the body.
    searchableAttributes: ['body', 'hashtags', 'romanized'],
    localizedAttributes: LOCALIZED_ATTRIBUTES,
    // demoRank (0 real / 1 demo) displayed so the FE can read the sample marker.
    displayedAttributes: ['id', 'authorId', 'body', 'hashtags', 'kind', 'createdAt', 'demoRank'],
    // Facets: filter by content kind, hashtag, author, recency.
    filterableAttributes: ['hashtags', 'kind', 'authorId', 'createdAt'],
    // Sort by recency or engagement; both numeric so the ranking rules are valid.
    // demoRank is sortable so the `demoRank:asc` ranking rule below is valid.
    sortableAttributes: ['createdAt', 'engagementScore', 'demoRank'],
    // Custom ranking on top of the Meili defaults: once relevance/exactness tie,
    // a more-engaged post outranks, then a fresher one breaks the remaining tie.
    // Same shape as the listings searchPriority:desc + createdAt:desc.
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'sort',
      'exactness',
      'engagementScore:desc',
      'createdAt:desc',
      // Demo Content scope: seeded sample posts sink below a real tie (see people
      // index note) — last rule, a down-rank not an exclusion.
      'demoRank:asc',
    ],
    // Same textile synonyms as people / listings - a buyer typing "zardozi" hits
    // the same canonical recall on posts too.
    synonyms: buildSynonymMap(TEXTILE_SYNONYM_GROUPS),
  },
};

const JOBS_INDEX_DEF: ConnectSearchIndexDef = {
  uid: CONNECT_JOBS_INDEX,
  settings: {
    // Title is the primary signal; description backs it up. Category + role are
    // also searchable so a custom trade/occupation term (self-registered via
    // TagService at post time) surfaces the job by name.
    searchableAttributes: ['title', 'description', 'category', 'role', 'romanized'],
    localizedAttributes: LOCALIZED_ATTRIBUTES,
    displayedAttributes: [
      'id',
      'title',
      'description',
      'category',
      'role',
      'companyPageId',
      'createdAt',
      // demoRank (0 real / 1 demo) displayed so the FE can read the sample marker.
      'demoRank',
    ],
    // Facets: filter by trade category, posting page, home district, recency.
    filterableAttributes: ['category', 'companyPageId', 'companyUserId', 'district', 'createdAt'],
    // demoRank is sortable so the `demoRank:asc` ranking rule below is valid.
    sortableAttributes: ['createdAt', 'demoRank'],
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'sort',
      'exactness',
      'createdAt:desc',
      // Demo Content scope: seeded sample jobs sink below a real tie (see people
      // index note) — last rule, a down-rank not an exclusion.
      'demoRank:asc',
    ],
    // Same textile synonyms as the other verticals.
    synonyms: buildSynonymMap(TEXTILE_SYNONYM_GROUPS),
  },
};

const STOREFRONTS_INDEX_DEF: ConnectSearchIndexDef = {
  uid: CONNECT_STOREFRONTS_INDEX,
  settings: {
    // Name is the strongest signal (a buyer typing a shop name wants that shop
    // first); description + categories back it up. `romanized` (SRCH-I18N-1)
    // appended LAST = lowest ranking weight so a Latin query reaches a
    // Gujarati-script shop name without outranking a real name hit. Not
    // displayed — a recall field only.
    searchableAttributes: ['name', 'description', 'categories', 'romanized'],
    localizedAttributes: LOCALIZED_ATTRIBUTES,
    displayedAttributes: [
      'id',
      'name',
      'slug',
      'logo',
      'description',
      'categories',
      'district',
      'ownerUserId',
      'createdAt',
      // demoRank (0 real / 1 demo) displayed so the FE can read the sample marker.
      'demoRank',
    ],
    // Facets: filter by district, category, and — security-critical — the owner
    // id so the per-viewer block filter + the author-active gate can reason about
    // the shop's owner (the same `ownerUserId` filter listings expose). Only
    // `public` shops are indexed, so no visibility facet is needed (the index-time
    // filter + hydration re-pin enforce it).
    filterableAttributes: ['district', 'categories', 'ownerUserId'],
    // demoRank is sortable so the `demoRank:asc` ranking rule below is valid.
    sortableAttributes: ['createdAt', 'demoRank'],
    // Same ranking shape as the other verticals: relevance/exactness, then a
    // recency tiebreak (createdAt is numeric unix-ms so the rule is valid).
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'sort',
      'exactness',
      'createdAt:desc',
      // Demo Content scope: seeded sample shops (owner is a demo account) sink
      // below a real tie (see people index note) — last rule, a down-rank not an
      // exclusion.
      'demoRank:asc',
    ],
    // Same textile synonyms as the other verticals — a buyer typing "zardozi"
    // reaches a shop whose name / categories carry the canonical recall term.
    synonyms: buildSynonymMap(TEXTILE_SYNONYM_GROUPS),
  },
};

const PAGES_INDEX_DEF: ConnectSearchIndexDef = {
  uid: CONNECT_PAGES_INDEX,
  settings: {
    // Name is the primary signal; about prose + the industry/institute free-tags
    // (specialization, coursesOffered) back it up so an institute surfaces by the
    // course names it teaches. `romanized` appended LAST = lowest ranking weight.
    searchableAttributes: ['name', 'about', 'tags', 'romanized'],
    localizedAttributes: LOCALIZED_ATTRIBUTES,
    displayedAttributes: [
      'id',
      'name',
      'slug',
      'kind',
      'logo',
      'about',
      'district',
      'ownerUserId',
      'createdAt',
      // demoRank (0 real / 1 demo) displayed so the FE can read the sample marker.
      'demoRank',
    ],
    // Facets: filter by `kind` (business vs institute — the institute label /
    // narrow), district, and the owner id (block filter + author-active gate
    // inheritance, exactly like storefronts / listings). Only `public` pages are
    // indexed, enforced at index time + re-pinned at hydration.
    filterableAttributes: ['kind', 'district', 'ownerUserId'],
    // demoRank is sortable so the `demoRank:asc` ranking rule below is valid.
    sortableAttributes: ['createdAt', 'demoRank'],
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'sort',
      'exactness',
      'createdAt:desc',
      // Demo Content scope: seeded sample pages (owner is a demo account) sink
      // below a real tie (see people index note) — last rule, a down-rank not an
      // exclusion.
      'demoRank:asc',
    ],
    synonyms: buildSynonymMap(TEXTILE_SYNONYM_GROUPS),
  },
};

/**
 * The registered Connect search indexes. Keyed by silo so callers read
 * `CONNECT_SEARCH_INDEXES.people` rather than re-deriving uids and settings.
 */
export const CONNECT_SEARCH_INDEXES = {
  people: PEOPLE_INDEX_DEF,
  listings: LISTINGS_INDEX_DEF,
  posts: POSTS_INDEX_DEF,
  jobs: JOBS_INDEX_DEF,
  storefronts: STOREFRONTS_INDEX_DEF,
  pages: PAGES_INDEX_DEF,
} satisfies Record<string, ConnectSearchIndexDef>;
