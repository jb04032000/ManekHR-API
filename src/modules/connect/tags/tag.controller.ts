import { Controller, Get, Query } from '@nestjs/common';
import { TagService } from './tag.service';
import { TagSearchQueryDto } from './dto/tag-search-query.dto';
import { TagTrendingQueryDto } from './dto/tag-trending-query.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * `/connect/tags` — Connect tag taxonomy (S1.3).
 *
 * Authed via the global `JwtAuthGuard`. Read-only autocomplete: `TagService`
 * emits an OTel span, so the controller adds no audit / PostHog noise.
 */
@LegacyUnclassified()
@Controller('connect/tags')
export class TagController {
  constructor(private readonly tagService: TagService) {}

  /** Tag autocomplete. `?q=<prefix>` returns `{ tags }` ranked by usage. */
  @Get('search')
  async search(@Query() query: TagSearchQueryDto) {
    const tags = await this.tagService.autocomplete(query.q ?? '', query.limit);
    return { tags };
  }

  /** Trending tags. Returns `{ tags }` ranked by trending score (S1.4 cron). */
  @Get('trending')
  async trending(@Query() query: TagTrendingQueryDto) {
    const tags = await this.tagService.getTrending(query.limit);
    return { tags };
  }
}
