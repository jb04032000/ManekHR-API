import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Public } from '../../../common/decorators/public.decorator';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';
import { CompanyPageService } from '../entities/services/company-page.service';
import { FeedService, type PublicFeedPage } from './feed.service';
import { PublicActivityQueryDto } from './dto/feed.dto';

/** JWT payload shape populated by `JwtAuthGuard` — `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/company-pages/:id/posts` -- a company page's PUBLIC posts, served to
 * anyone (logged-out included). The page counterpart of
 * `ConnectProfileActivityPublicController`.
 *
 * Lives in the Feed module (not Entities) because it reads the feed's `Post`
 * collection via `FeedService` -- Feed already imports `ConnectEntitiesModule`
 * (for the page-post ownership gate), so `CompanyPageService` injects directly.
 * Resolving the page first 404-gates a hidden / unknown page before any post is
 * exposed (its result is discarded; the call only gates).
 */
@Controller('connect/company-pages')
export class ConnectCompanyPageActivityPublicController {
  constructor(
    private readonly companyPages: CompanyPageService,
    private readonly feedService: FeedService,
  ) {}

  @Public()
  @Get(':id/posts')
  async getPagePosts(
    @Param('id') id: string,
    @Query() query: PublicActivityQueryDto,
  ): Promise<PublicFeedPage> {
    // 404-gate: a hidden / unknown page must not leak posts.
    await this.companyPages.getPublicById(id);
    return this.feedService.getCompanyPageActivity(id, query.cursor);
  }

  /**
   * The owner's OWN page posts for the manage console. Authed (not `@Public()`,
   * so `req.user` is populated) and owner-gated via `getMine`, which 404s a page
   * the caller does not own. Unlike the public route above, this returns posts
   * for a hidden / draft page too, so the owner can see what they have posted
   * before the page goes live.
   */
  @LegacyUnclassified()
  @Get(':id/manage/posts')
  async getOwnPagePosts(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query() query: PublicActivityQueryDto,
  ): Promise<PublicFeedPage> {
    await this.companyPages.getMine(req.user.sub, id);
    // Owner view: include non-public posts so the list matches the stat badge
    // (the owner sees their drafts / connections-only posts too).
    return this.feedService.getCompanyPageActivity(id, query.cursor, { includeNonPublic: true });
  }
}
