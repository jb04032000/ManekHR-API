import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../../common/decorators/public.decorator';
import { ConnectProfileService } from '../profile/connect-profile.service';
import { FeedService, type PublicFeedPage } from './feed.service';
import { PublicActivityQueryDto } from './dto/feed.dto';

/**
 * `connect/profiles/:slug/activity` — a profile owner's PUBLIC posts, served to
 * anyone (logged-out included). The public counterpart of the authenticated
 * `/me/connect/feed/activity` Posts tab.
 *
 * Mirrors `ConnectProfilePublicController`'s `:slug/erp-link` 404-gate: resolve
 * the slug to a userId, then `getPublicByUserId` to reject a hidden /
 * non-public / unknown profile BEFORE any post data is exposed. The
 * `getPublicByUserId` result is intentionally discarded; its only job is to
 * 404-gate.
 *
 * Posts only. Comments + reactions are owner-only and are never served on a
 * public surface (`FeedService.getPublicActivity` returns posts exclusively).
 *
 * Lives in the Feed module (not the Profile module) because it reads the feed's
 * `Post` collection via `FeedService`. `ConnectProfileModule` is already
 * imported by `ConnectFeedModule`, so `ConnectProfileService` injects directly.
 * `@Public()` + `@Get()` only — public Connect reads carry no throttler tier
 * (matches `ConnectProfilePublicController` + `FeedPublicController`).
 */
@Controller('connect/profiles')
export class ConnectProfileActivityPublicController {
  constructor(
    private readonly profileService: ConnectProfileService,
    private readonly feedService: FeedService,
  ) {}

  @Public()
  @Get(':slug/activity')
  async getPublicActivity(
    @Param('slug') slug: string,
    @Query() query: PublicActivityQueryDto,
  ): Promise<PublicFeedPage> {
    // 404-gate: a hidden / non-public / unknown profile must not leak posts.
    const userId = await this.profileService.resolveSlugToUserId(slug);
    await this.profileService.getPublicByUserId(userId);
    return this.feedService.getPublicActivity(userId, query.cursor);
  }
}
