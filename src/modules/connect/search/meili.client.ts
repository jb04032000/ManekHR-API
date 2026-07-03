import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { env } from '../../../config/env';

/**
 * A single Meilisearch document hit — Meilisearch echoes the stored document,
 * so the shape is whatever was upserted. Callers narrow it themselves.
 */
export type MeiliDocument = Record<string, unknown>;

/** Options accepted by {@link MeiliClient.ensureIndex} index-settings push. */
export interface MeiliIndexSettings {
  /** Attributes Meilisearch ranks a query against (ordered — first = strongest). */
  searchableAttributes?: string[];
  /** Attributes returned on a hit. Omit → every attribute is returned. */
  displayedAttributes?: string[];
  /** Attributes a `filter` expression may reference. */
  filterableAttributes?: string[];
  /** Attributes a `sort` expression may reference. */
  sortableAttributes?: string[];
  /** Two-way query expansions. Each term maps to its equivalents. Additive recall only. */
  synonyms?: Record<string, string[]>;
  /** Tokens ignored during search. Keep minimal, never a real domain query term. */
  stopWords?: string[];
  /** Ranking rule order. Omit to keep the Meilisearch defaults. */
  rankingRules?: string[];
  /** Per-locale attribute hints (for example hin / guj) for tokenization. */
  localizedAttributes?: Array<{ locales: string[]; attributePatterns: string[] }>;
}

/** One leg of a {@link MeiliClient.multiSearch} federation request. */
export interface MeiliFederatedQuery {
  /** Index this leg queries. */
  indexUid: string;
  /** Free-text term. A blank term with no `filter` is a no-op (skipped). */
  q: string;
  /** Optional facet filter; a blank `q` WITH a filter is a valid browse. */
  filter?: string | string[];
  /** Per-leg hit cap (the page size when paginating). */
  limit: number;
  /** Skip the first N hits - pagination. Default 0 (first page). */
  offset?: number;
  /**
   * Attributes for which Meilisearch should return a count distribution across
   * the matched documents. Only attributes listed in the index's
   * `filterableAttributes` settings are valid; others are silently ignored by
   * Meilisearch. Pass `['category', 'tags']` on the listings leg so the web
   * can rank tag-filter chips by listing count.
   */
  facets?: string[];
  /**
   * Explicit result ordering, as Meilisearch `attr:direction` rules (for
   * example `['priceMin:asc']` or `['verified:desc', 'createdAt:desc']`). Each
   * referenced attribute MUST be in the index's `sortableAttributes`; an empty /
   * omitted array leaves ordering to the index ranking rules (the default). The
   * listings leg passes the sort the marketplace dropdown selected.
   */
  sort?: string[];
}

/**
 * The per-leg result returned by {@link MeiliClient.multiSearch}. Carries both
 * the ranked hits and, when the leg requested facets, the distribution counts.
 */
export interface MeiliSearchLegResult {
  hits: MeiliDocument[];
  /** Present only when the query leg included a `facets` array AND Meilisearch
   *  returned distribution data. Keys are attribute names; values are
   *  `{ [facetValue]: count }` maps. */
  facetDistribution?: Record<string, Record<string, number>>;
  /** Meilisearch's count of ALL matches (not just this page). Drives the web
   *  marketplace's infinite-scroll hasMore (offset + hits.length < total). */
  estimatedTotalHits?: number;
}

/** The relevant slice of a Meilisearch `POST /multi-search` response. */
interface MeiliMultiSearchResponse {
  results?: Array<{
    hits?: MeiliDocument[];
    facetDistribution?: Record<string, Record<string, number>>;
    estimatedTotalHits?: number;
  }>;
}

/**
 * `MeiliClient` — a thin, dependency-free Meilisearch REST client.
 *
 * Deliberately built on the platform `fetch` rather than the `meilisearch`
 * npm package: the surface Connect needs (search / upsert / delete / ensure
 * index) is a handful of REST calls, and adding a dependency for that is not
 * worth the supply-chain + bundle cost.
 *
 * **Resilience contract.** Search is a *progressive enhancement* over the
 * Connect graph, never load-bearing. Every HTTP call is wrapped in try/catch:
 * a Meilisearch outage (down host, network error, 5xx) is logged + sent to
 * Sentry and then *swallowed* — it MUST NEVER throw into a request thread.
 * `search` degrades to `[]` (the caller — `SearchService` — then falls back
 * to a Mongo-regex query); the write methods degrade to a no-op (the index
 * goes momentarily stale, self-healing on the next profile write or a
 * `reindexAllPeople` run).
 *
 * **Disabled mode.** When `MEILI_HOST` is blank ({@link enabled} is `false`)
 * every method is a safe no-op — no HTTP is attempted at all. This is the
 * default local / CI posture, and lets `SearchService` run the Mongo fallback
 * with zero configuration.
 */
@Injectable()
export class MeiliClient {
  private readonly logger = new Logger(MeiliClient.name);

  /** Base URL, trailing slash trimmed so path joins are unambiguous. */
  private readonly host = env.meili.host.replace(/\/$/, '');
  private readonly apiKey = env.meili.apiKey;

  /**
   * Whether a Meilisearch deployment is configured. When `false` every method
   * short-circuits to a no-op and `SearchService` uses the Mongo fallback.
   */
  get enabled(): boolean {
    return Boolean(this.host);
  }

  /**
   * Federated search across several indexes in ONE round-trip via Meilisearch
   * `POST /multi-search`. Returns one hit array per input query, aligned to
   * input order. This is the seam the federated query layer (S1.5) is built on:
   * a new vertical joins search by adding its index to the federation, never a
   * second HTTP round-trip.
   *
   * A leg whose `q` is blank AND carries no `filter` would match the whole
   * index, so it is skipped (its slot resolves to `[]`) and never sent. When
   * every leg is a no-op — or Meili is disabled, or the call faults — the
   * result is `[]` for every slot and nothing throws (same resilience contract
   * as {@link search}); the caller then degrades to the Mongo fallback.
   */
  async multiSearch(queries: MeiliFederatedQuery[]): Promise<MeiliSearchLegResult[]> {
    if (!this.enabled || queries.length === 0) return queries.map(() => ({ hits: [] }));

    // Keep only the legs worth sending, remembering each one's original slot so
    // the response maps back to the caller's query order.
    const sendable: Array<{ slot: number; leg: MeiliFederatedQuery }> = [];
    queries.forEach((query, slot) => {
      const trimmed = query.q.trim();
      const hasFilter = Array.isArray(query.filter)
        ? query.filter.length > 0
        : Boolean(query.filter);
      if (trimmed || hasFilter) {
        sendable.push({ slot, leg: { ...query, q: trimmed } });
      }
    });

    const out: MeiliSearchLegResult[] = queries.map(() => ({ hits: [] }));
    if (sendable.length === 0) return out;

    const body = await this.request<MeiliMultiSearchResponse>(
      'POST',
      '/multi-search',
      {
        queries: sendable.map(({ leg }) => ({
          indexUid: leg.indexUid,
          q: leg.q,
          limit: leg.limit,
          ...(leg.offset ? { offset: leg.offset } : {}),
          ...(leg.filter ? { filter: leg.filter } : {}),
          ...(leg.facets ? { facets: leg.facets } : {}),
          ...(leg.sort && leg.sort.length > 0 ? { sort: leg.sort } : {}),
        })),
      },
      'multiSearch',
    );

    const results = body?.results ?? [];
    sendable.forEach(({ slot }, sentIndex) => {
      const raw = results[sentIndex];
      out[slot] = {
        hits: raw?.hits ?? [],
        ...(raw?.facetDistribution ? { facetDistribution: raw.facetDistribution } : {}),
        ...(typeof raw?.estimatedTotalHits === 'number'
          ? { estimatedTotalHits: raw.estimatedTotalHits }
          : {}),
      };
    });
    return out;
  }

  /**
   * Upsert (add-or-replace) documents into an index. Meilisearch matches on
   * the index primary key — here always `id` — so re-sending a document with
   * the same `id` replaces it. A no-op when disabled or when `docs` is empty.
   */
  async upsertDocuments(index: string, docs: MeiliDocument[]): Promise<void> {
    if (!this.enabled || docs.length === 0) return;
    await this.request<unknown>(
      'POST',
      `/indexes/${encodeURIComponent(index)}/documents`,
      docs,
      'upsertDocuments',
    );
  }

  /** Delete a single document by its primary-key value. No-op when disabled. */
  async deleteDocument(index: string, id: string): Promise<void> {
    if (!this.enabled) return;
    await this.request<unknown>(
      'DELETE',
      `/indexes/${encodeURIComponent(index)}/documents/${encodeURIComponent(id)}`,
      undefined,
      'deleteDocument',
    );
  }

  /**
   * Ensure an index exists with the given settings — idempotent first-run
   * provisioning. Creates the index (primary key `id`) if absent, then pushes
   * the settings patch. Both calls are individually fault-tolerant; a partial
   * failure leaves the index usable and self-heals on the next call. No-op
   * when disabled.
   */
  async ensureIndex(index: string, settings: MeiliIndexSettings = {}): Promise<void> {
    if (!this.enabled) return;
    // `POST /indexes` is idempotent on the Meilisearch side — re-creating an
    // existing index is accepted (the task simply no-ops), so no pre-check.
    await this.request<unknown>(
      'POST',
      '/indexes',
      { uid: index, primaryKey: 'id' },
      'ensureIndex.create',
    );
    if (Object.keys(settings).length > 0) {
      await this.request<unknown>(
        'PATCH',
        `/indexes/${encodeURIComponent(index)}/settings`,
        settings,
        'ensureIndex.settings',
      );
    }
  }

  /**
   * Single choke-point for every Meilisearch HTTP call. Attaches the bearer
   * token, parses JSON, and — critically — never lets a failure escape: a
   * network error or non-2xx status is logged, Sentry-captured, and returns
   * `null` so the caller degrades gracefully.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    op: string,
  ): Promise<T | null> {
    try {
      const response = await fetch(`${this.host}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (!response.ok) {
        // A non-2xx is an operational fault, not a request-thread error —
        // log + capture + degrade, exactly like a thrown network error.
        const detail = await response.text().catch(() => '');
        this.logFailure(op, `HTTP ${response.status} ${response.statusText} ${detail}`.trim());
        return null;
      }

      // 204 (and an empty 202 task body) carry no JSON — guard the parse.
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : null;
    } catch (err) {
      this.logFailure(op, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /** Log + Sentry-capture a Meilisearch fault. Never rethrows. */
  private logFailure(op: string, detail: string): void {
    this.logger.warn(
      `MeiliClient.${op} failed — degrading (search falls back to Mongo). ${detail}`,
    );
    Sentry.captureException(new Error(`MeiliClient.${op} failed: ${detail}`), {
      tags: { module: 'connect.search', op },
    });
  }
}
