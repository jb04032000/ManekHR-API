import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import * as Sentry from '@sentry/nestjs';
import { ConnectTag, type ConnectTagCategory } from './schemas/connect-tag.schema';
import { PostHogService } from '../../../common/posthog/posthog.service';

/** Max autocomplete suggestions returned. */
const AUTOCOMPLETE_CAP = 10;

/** Max trending tags returned. */
const TRENDING_RESULT_CAP = 20;

/** A viewer-facing tag suggestion. */
export interface ConnectTagView {
  slug: string;
  labels: Record<string, string | undefined>;
  category: ConnectTagCategory;
  usageCount: number;
  trendingScore: number;
}

/** The lean `ConnectTag` slice read for a view. */
type TagLeanRow = {
  slug: string;
  labels?: Record<string, string | undefined>;
  category?: ConnectTagCategory;
  usageCount?: number;
  trendingScore?: number;
};

/**
 * `TagService` — the Connect tag taxonomy (S1.3).
 *
 * - `normalizeHashtags` resolves raw `#tags` to canonical slugs via the alias
 *   table; an unknown tag stays its own slug (the open-tag path).
 * - `recordUsage` upserts the tag (creating an open tag on first use) and bumps
 *   `usageCount`. Called fire-and-forget from post create, so it swallows every
 *   error: a tag hiccup must never break posting.
 * - `autocomplete` prefix-matches slug / alias for `GET /connect/tags/search`.
 */
@Injectable()
export class TagService {
  private readonly logger = new Logger(TagService.name);
  private readonly tracer = trace.getTracer('connect.tags');

  constructor(
    @InjectModel(ConnectTag.name) private readonly tagModel: Model<ConnectTag>,
    @Optional() private readonly posthog?: PostHogService,
  ) {}

  /**
   * Resolve raw hashtags to canonical slugs: a tag whose slug or alias matches
   * wins; an unknown tag becomes its own slug. Lowercased + de-duplicated, with
   * first-seen order kept.
   */
  async normalizeHashtags(raw: string[]): Promise<string[]> {
    const cleaned = [...new Set(raw.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
    if (cleaned.length === 0) return [];

    const tags = await this.tagModel
      .find({ $or: [{ slug: { $in: cleaned } }, { aliases: { $in: cleaned } }] })
      .select('slug aliases')
      .lean<Array<{ slug: string; aliases?: string[] }>>()
      .exec();

    const toSlug = new Map<string, string>();
    for (const tag of tags) {
      toSlug.set(tag.slug, tag.slug);
      for (const alias of tag.aliases ?? []) toSlug.set(alias, tag.slug);
    }

    const out: string[] = [];
    const seen = new Set<string>();
    for (const term of cleaned) {
      const slug = toSlug.get(term) ?? term;
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(slug);
      }
    }
    return out;
  }

  /**
   * Bump `usageCount` for each slug, creating an open tag on first use. Fire-and
   * -forget from post create, so it swallows every error. `actorUserId` is the
   * PostHog distinct id.
   */
  async recordUsage(slugs: string[], actorUserId: string): Promise<void> {
    if (slugs.length === 0) return;
    try {
      const results = await Promise.all(
        slugs.map((slug) =>
          this.tagModel
            .updateOne(
              { slug },
              {
                $inc: { usageCount: 1 },
                $setOnInsert: { aliases: [], category: 'generic', isCurated: false },
              },
              { upsert: true },
            )
            .exec(),
        ),
      );
      const created = results.reduce((total, result) => total + (result?.upsertedCount ?? 0), 0);
      this.posthog?.capture({
        distinctId: actorUserId,
        event: 'connect.tag_used',
        properties: { count: slugs.length, created },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`TagService.recordUsage failed (degraded): ${detail}`);
      Sentry.captureException(err, { tags: { module: 'connect.tags', op: 'recordUsage' } });
    }
  }

  /** Prefix-match slug or alias for tag autocomplete, ranked by usage then trending. */
  async autocomplete(query: string, limit = AUTOCOMPLETE_CAP): Promise<ConnectTagView[]> {
    const term = query.trim().toLowerCase();
    if (!term) return [];

    return this.withSpan('connect.tags.autocomplete', async (span) => {
      const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(`^${safe}`, 'i');
      const cap = Math.min(Math.max(limit, 1), AUTOCOMPLETE_CAP);

      const tags = await this.tagModel
        .find({ $or: [{ slug: rx }, { aliases: rx }] })
        .sort({ usageCount: -1, trendingScore: -1 })
        .limit(cap)
        .lean<TagLeanRow[]>()
        .exec();

      span.setAttribute('resultCount', tags.length);
      return tags.map((tag) => this.toView(tag));
    });
  }

  /** Top tags by trending score (written by the S1.4 cron), highest first. */
  async getTrending(limit = TRENDING_RESULT_CAP): Promise<ConnectTagView[]> {
    const cap = Math.min(Math.max(limit, 1), TRENDING_RESULT_CAP);
    const tags = await this.tagModel
      .find({ trendingScore: { $gt: 0 } })
      .sort({ trendingScore: -1 })
      .limit(cap)
      .lean<TagLeanRow[]>()
      .exec();
    return tags.map((tag) => this.toView(tag));
  }

  /** Map a lean tag row to the viewer-facing shape (labels fall back to {}). */
  private toView(tag: TagLeanRow): ConnectTagView {
    return {
      slug: tag.slug,
      labels: tag.labels ?? {},
      category: tag.category ?? 'generic',
      usageCount: tag.usageCount ?? 0,
      trendingScore: tag.trendingScore ?? 0,
    };
  }

  private async withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
