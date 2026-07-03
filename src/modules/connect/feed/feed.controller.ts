import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post as HttpPost,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Public } from '../../../common/decorators/public.decorator';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { AppModule } from '../../../common/enums/modules.enum';
import { AuditService } from '../../audit/audit.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { FeedService } from './feed.service';
import { ReactionService } from './reaction.service';
import { CommentService } from './comment.service';
import {
  ActivityQueryDto,
  CommentsQueryDto,
  CreateCommentDto,
  CreatePostDto,
  EditPostDto,
  FeedQueryDto,
  SavedQueryDto,
} from './dto/feed.dto';
import { NegativeSignalDto } from './dto/negative-signal.dto';
import { RecordViewsDto } from './dto/record-views.dto';
import { RepostDto } from './dto/repost.dto';
import { SOCKET_TICKET_AUDIENCE, SOCKET_TICKET_TTL } from './feed-realtime';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by `JwtAuthGuard` — `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `/me/connect/feed` — the caller's feed, posts, reactions, comments
 * (Phase 3 — Feed).
 *
 * `JwtAuthGuard` only — Connect is feature-flagged, NOT subscription-gated
 * (mirrors `NetworkController`). Post / comment writes are audited and emit a
 * PostHog event; reactions emit a PostHog event only (too high-volume to
 * audit — their notification side is batched in Wave 5, §12.3).
 */
@LegacyUnclassified()
@Controller('me/connect/feed')
@UseGuards(JwtAuthGuard)
export class FeedController {
  constructor(
    private readonly feedService: FeedService,
    private readonly reactionService: ReactionService,
    private readonly commentService: CommentService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
    private readonly jwtService: JwtService,
  ) {}

  // ── Feed read ────────────────────────────────────────────────────────────

  /** One page of the caller's feed — `?tab=following|foryou&cursor=`. */
  @Get()
  getFeed(@Req() req: AuthedRequest, @Query() query: FeedQueryDto) {
    return this.feedService.getFeed(req.user.sub, query.tab ?? 'foryou', query.cursor);
  }

  /**
   * One page of the caller's OWN activity — backs the profile Activity tab.
   * `?type=posts|comments|reactions&cursor=`. Read-only own data: no audit /
   * PostHog (mirrors `getFeed` / `listSaved`).
   */
  @Get('activity')
  getActivity(@Req() req: AuthedRequest, @Query() query: ActivityQueryDto) {
    return this.feedService.getActivity(req.user.sub, query.type ?? 'posts', query.cursor);
  }

  /**
   * Mint a short-lived socket ticket for the realtime gateway. The browser
   * cannot read the httpOnly access cookie to authenticate a cross-origin
   * socket, so it connects with this `connect-socket`-audience ticket — which,
   * by that `aud` claim, can never be replayed as an API access token.
   */
  @HttpPost('realtime/ticket')
  realtimeTicket(@Req() req: AuthedRequest) {
    const ticket = this.jwtService.sign(
      { sub: req.user.sub },
      { audience: SOCKET_TICKET_AUDIENCE, expiresIn: SOCKET_TICKET_TTL },
    );
    return { ticket };
  }

  /** The From-your-ERP callout summary — owner headcount + month payroll. */
  @Get('erp-summary')
  getErpSummary(@Req() req: AuthedRequest) {
    return this.feedService.getErpSummary(req.user.sub);
  }

  /** Compact trending posts for the right-rail "Trending in your trade" panel. */
  @Get('trending')
  getTrending(@Req() req: AuthedRequest) {
    return this.feedService.getTrendingRail(req.user.sub);
  }

  // ── Posts ────────────────────────────────────────────────────────────────

  /** Create a feed post. */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  @HttpPost('posts')
  async createPost(@Req() req: AuthedRequest, @Body() dto: CreatePostDto) {
    const created = await this.feedService.createPost(req.user.sub, dto);
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Post',
      entityId: String(created._id),
      action: 'create',
      actorId: req.user.sub,
      meta: { kind: dto.kind },
    });
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.post_created',
      properties: { kind: dto.kind },
    });
    return created;
  }

  /** Edit one of the caller's own posts (body / tags / visibility). */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  @Patch('posts/:postId')
  async editPost(
    @Req() req: AuthedRequest,
    @Param('postId') postId: string,
    @Body() dto: EditPostDto,
  ) {
    const updated = await this.feedService.editPost(req.user.sub, postId, dto);
    const fieldsChanged = Object.keys(dto).filter((k) => dto[k as keyof EditPostDto] !== undefined);
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Post',
      entityId: postId,
      action: 'update',
      actorId: req.user.sub,
      meta: { fieldsChanged },
    });
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.post_edited',
      properties: { postId, kind: updated.kind },
    });
    return updated;
  }

  /** Delete one of the caller's own posts. */
  @Delete('posts/:postId')
  async deletePost(@Req() req: AuthedRequest, @Param('postId') postId: string) {
    await this.feedService.deletePost(req.user.sub, postId);
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Post',
      entityId: postId,
      action: 'delete',
      actorId: req.user.sub,
      meta: {},
    });
    return { deleted: true };
  }

  /** Repost a post (optionally with a quote). Audited as a new Post create. */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  @HttpPost('posts/:postId/repost')
  async repost(@Req() req: AuthedRequest, @Param('postId') postId: string, @Body() dto: RepostDto) {
    const created = await this.feedService.repost(req.user.sub, postId, dto.quote);
    const isQuote = Boolean(dto.quote?.trim());
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Post',
      entityId: String(created._id),
      action: 'create',
      actorId: req.user.sub,
      meta: { repostOf: postId, quote: isQuote },
    });
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.post_reposted',
      properties: { postId, quote: isQuote },
    });
    return created;
  }

  /** Undo the caller's plain repost of a post. */
  @Delete('posts/:postId/repost')
  async unrepost(@Req() req: AuthedRequest, @Param('postId') postId: string) {
    await this.feedService.unrepost(req.user.sub, postId);
    return { reposted: false };
  }

  // ── Saved posts ──────────────────────────────────────────────────────────

  /** The caller's saved posts, newest-saved first. `?cursor=` walks the list. */
  @Get('saved')
  listSaved(@Req() req: AuthedRequest, @Query() query: SavedQueryDto) {
    return this.feedService.listSaved(req.user.sub, query.cursor);
  }

  /** Save (bookmark) a post for the caller. Idempotent. PostHog only (a private,
   *  low-volume engagement signal; not audited, mirroring reactions). */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-engage': { limit: 90, ttl: 60_000 } })
  @HttpPost('posts/:postId/save')
  async savePost(@Req() req: AuthedRequest, @Param('postId') postId: string) {
    const result = await this.feedService.savePost(req.user.sub, postId);
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.post_saved',
      properties: { postId },
    });
    return result;
  }

  /** Un-save (remove the bookmark) for the caller. */
  @Delete('posts/:postId/save')
  unsavePost(@Req() req: AuthedRequest, @Param('postId') postId: string) {
    return this.feedService.unsavePost(req.user.sub, postId);
  }

  // ── Reactions ────────────────────────────────────────────────────────────

  /** Add the caller's reaction to a post. (Caps like-spam + the like/unlike
   *  loop, since every toggle round-trip needs this create half.) */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-engage': { limit: 90, ttl: 60_000 } })
  @HttpPost('posts/:postId/reactions')
  async react(@Req() req: AuthedRequest, @Param('postId') postId: string) {
    const result = await this.reactionService.react(req.user.sub, postId);
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.post_reacted',
      properties: { postId },
    });
    return result;
  }

  /** Remove the caller's reaction from a post. */
  @Delete('posts/:postId/reactions')
  unreact(@Req() req: AuthedRequest, @Param('postId') postId: string) {
    return this.reactionService.unreact(req.user.sub, postId);
  }

  // ── Comments ─────────────────────────────────────────────────────────────

  /**
   * Comment on a post (or reply, one level deep).
   *
   * Three layered anti-spam nets (see `CommentService.addComment`):
   *   1. the global `connect-engage` throttle (account-wide, 90/min);
   *   2. `@Idempotent()` — an optional `Idempotency-Key` header makes a network
   *      retry of the SAME request return the cached first response instead of
   *      writing twice (interceptor pattern, no FE change required);
   *   3. per-(user,post) rate limits + a 30s duplicate-body window in the
   *      service, which also covers clients that send no idempotency key.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-engage': { limit: 90, ttl: 60_000 } })
  @Idempotent()
  @HttpPost('posts/:postId/comments')
  async addComment(
    @Req() req: AuthedRequest,
    @Param('postId') postId: string,
    @Body() dto: CreateCommentDto,
  ) {
    const created = await this.commentService.addComment(
      req.user.sub,
      postId,
      dto.body,
      dto.parentId,
      dto.mentions,
    );
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Comment',
      entityId: String(created._id),
      action: 'create',
      actorId: req.user.sub,
      meta: { postId, isReply: Boolean(dto.parentId) },
    });
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.post_commented',
      properties: { postId, isReply: Boolean(dto.parentId) },
    });
    return created;
  }

  /** One page of a post's comment thread (keyset-paginated, newest-first).
   *  CN-FEED-5: the viewer is threaded so the service can 404 a thread the
   *  caller cannot see (connections-only / blocked either direction). */
  @Get('posts/:postId/comments')
  listComments(
    @Req() req: AuthedRequest,
    @Param('postId') postId: string,
    @Query() query: CommentsQueryDto,
  ) {
    return this.commentService.listComments(postId, req.user.sub, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /**
   * "Show me less" — hide a post / not-interested / mute an author (Phase 7c/7d).
   * Throttled on the `connect-engage` tier (a one-tap feedback action). Idempotent
   * — a repeat is a no-op. hide + not-interested + mute hard-exclude from both tabs;
   * not-interested also dampens For-You. Owner-scoped (the JWT `sub` is the only
   * viewer touched).
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-engage': { limit: 90, ttl: 60_000 } })
  @HttpPost('negative')
  async addNegativeSignal(@Req() req: AuthedRequest, @Body() dto: NegativeSignalDto) {
    await this.feedService.addNegativeSignal(req.user.sub, dto.kind, dto.targetId);
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.feed_feedback',
      properties: { kind: dto.kind, action: 'add' },
    });
    return { ok: true };
  }

  /**
   * Undo a "show me less" signal (Phase 7d). Idempotent — undoing one that was
   * never set is a no-op. Same throttle tier + owner scope as the add.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-engage': { limit: 90, ttl: 60_000 } })
  @Delete('negative')
  async removeNegativeSignal(@Req() req: AuthedRequest, @Body() dto: NegativeSignalDto) {
    await this.feedService.removeNegativeSignal(req.user.sub, dto.kind, dto.targetId);
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.feed_feedback',
      properties: { kind: dto.kind, action: 'undo' },
    });
    return { ok: true };
  }

  /**
   * Record a viewport-impression batch — bumps each post's view count (first
   * unique view per viewer) and marks them seen for discovery-suppression.
   * Read-side telemetry: no audit, no PostHog (OTel span only in the service).
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-engage': { limit: 90, ttl: 60_000 } })
  @HttpPost('views')
  recordViews(@Req() req: AuthedRequest, @Body() dto: RecordViewsDto) {
    return this.feedService.recordViews(req.user.sub, dto.postIds);
  }

  /** Delete one of the caller's own comments. */
  @Delete('comments/:commentId')
  async deleteComment(@Req() req: AuthedRequest, @Param('commentId') commentId: string) {
    await this.commentService.deleteComment(req.user.sub, commentId);
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Comment',
      entityId: commentId,
      action: 'delete',
      actorId: req.user.sub,
      meta: {},
    });
    return { deleted: true };
  }
}

/**
 * `/connect/posts/:postId` — public, unauthenticated single-post read.
 *
 * Only `public`-visibility, non-deleted posts resolve; everything else 404s.
 * Backs the shareable / WhatsApp-linked post URL.
 */
@Controller('connect/posts')
export class FeedPublicController {
  constructor(private readonly feedService: FeedService) {}

  @Public()
  @Get(':postId')
  getPublic(@Param('postId') postId: string) {
    return this.feedService.getPublicPost(postId);
  }
}
