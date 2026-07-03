import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { Public } from '../../../common/decorators/public.decorator';
import {
  ConnectSitemapService,
  SitemapCounts,
  SitemapEntry,
  SitemapSection,
} from './connect-sitemap.service';

/** `?chunk=N` -- 0-based page index for a sitemap section read. */
class SitemapChunkQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  chunk?: number;
}

/**
 * ManekHR Connect -- Sitemap endpoints (public, projection-only).
 *
 * Feeds the web app's dynamic sitemap index (the web app cannot query Mongo
 * directly). All `@Public()` (crawler-facing, logged-out): `counts` tells the
 * index how many 10k chunks each section needs; `:section?chunk=N` returns the
 * {ref, updatedAt} rows for one chunk. Read-only, no entity bodies -- only the
 * URL ref + lastmod -- so nothing sensitive leaks. Throttled modestly per IP (a
 * crawler hits each chunk once per crawl). See ConnectSitemapService for the
 * per-section public/active filters and the listing-suppression reuse.
 */
@Controller('connect/sitemap')
export class ConnectSitemapController {
  constructor(private readonly sitemap: ConnectSitemapService) {}

  /** Total publicly-indexable counts per section (chunk-count math for the index). */
  @Public()
  @Get('counts')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  counts(): Promise<SitemapCounts> {
    return this.sitemap.counts();
  }

  /**
   * One section's chunk of {ref, updatedAt} rows. `section` is validated against
   * the known set inside the service (404-ish BadRequest on an unknown value);
   * `chunk` defaults to 0.
   */
  @Public()
  @Get(':section')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  section(
    @Param('section') section: SitemapSection,
    @Query() query: SitemapChunkQueryDto,
  ): Promise<{ entries: SitemapEntry[] }> {
    return this.sitemap.section(section, query.chunk ?? 0);
  }
}
