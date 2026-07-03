import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsMongoId,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  POST_KINDS,
  POST_MEDIA_LAYOUTS,
  POST_MEDIA_TYPES,
  POST_VISIBILITIES,
  type PostKind,
  type PostMediaLayout,
  type PostMediaType,
  type PostVisibility,
} from '../schemas/post.schema';
import { MENTION_TYPES, type MentionType } from '../schemas/mention.subschema';

/**
 * DTOs for the `connect/feed` controller — post creation, comments, and the
 * feed-list query (`docs/connect/phases/phase-3-feed.md` B3 / B5).
 */

/** One photo / video / document attachment in a `CreatePostDto`. */
export class PostMediaDto {
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  url: string;

  @IsIn(POST_MEDIA_TYPES)
  type: PostMediaType;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  caption?: string;

  /**
   * Poster (thumbnail) URL for a `video` item — a client-captured frame the
   * composer uploaded as a normal post image. Optional (capture can fail on
   * mobile). Same https-only hardening as `url`; `feed.service` runs it through
   * the media-ownership guard so a poster must be a file THIS user uploaded.
   */
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  posterUrl?: string;
}

/** The recording in a `CreatePostDto` — present only on a `voice` post. */
export class PostAudioDto {
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  url: string;

  /** Clip length in seconds — capped at 10 minutes. */
  @IsInt()
  @Min(1)
  @Max(600)
  durationSec: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  transcript?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  transcriptLang?: string;
}

/**
 * One @mention (tag) the composer picker produced. The picker is the source of
 * truth for type + refId + display; the link-ready `href` is computed server-side
 * (never trusted from the client) by MentionService.
 */
export class MentionInputDto {
  @IsIn(MENTION_TYPES)
  type: MentionType;

  @IsMongoId()
  refId: string;

  @IsString()
  @MaxLength(120)
  display: string;
}

/** POST `/me/connect/feed/posts` — create a feed post. */
export class CreatePostDto {
  @IsIn(POST_KINDS)
  kind: PostKind;

  /** The written body / caption. `hashtags` are parsed from it server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  body?: string;

  /** Photo / video / document attachments (for `photo` / `video` / `document`). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  media?: PostMediaDto[];

  /** The recording (for the `voice` kind). */
  @IsOptional()
  @ValidateNested()
  @Type(() => PostAudioDto)
  audio?: PostAudioDto;

  /** "Open to …"-style intent tags chosen in the composer. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(POST_VISIBILITIES)
  visibility?: PostVisibility;

  /** How a multi-photo `photo` post renders: `grid` (default) or `carousel`. */
  @IsOptional()
  @IsIn(POST_MEDIA_LAYOUTS)
  mediaLayout?: PostMediaLayout;

  /**
   * OPTIONAL: publish this post AS a company page the caller owns. The service
   * verifies ownership; the post then fans out to the page's followers. Omit for
   * a normal personal post.
   */
  @IsOptional()
  @IsMongoId()
  companyPageId?: string;

  /** @mentions (tags) the composer picker produced. href computed server-side. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MentionInputDto)
  mentions?: MentionInputDto[];
}

/**
 * PATCH `/me/connect/feed/posts/:postId` — edit an existing post's text fields.
 * Only the supplied fields change; `hashtags` re-parse from a changed `body`
 * server-side. Media / audio / kind are not editable in v1.
 */
export class EditPostDto {
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  body?: string;

  /** "Open to …"-style intent tags. Replaces the existing set when supplied. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(POST_VISIBILITIES)
  visibility?: PostVisibility;

  /** How a multi-photo `photo` post renders: `grid` (default) or `carousel`.
   *  Display-only flip on existing media; ignored on a non-photo post. */
  @IsOptional()
  @IsIn(POST_MEDIA_LAYOUTS)
  mediaLayout?: PostMediaLayout;

  /** @mentions (tags) the composer picker produced. href computed server-side. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MentionInputDto)
  mentions?: MentionInputDto[];
}

/** POST `/me/connect/feed/posts/:postId/comments` — comment on a post. */
export class CreateCommentDto {
  @IsString()
  @MaxLength(1000)
  body: string;

  /** Parent comment id for a one-level reply; omit for a top-level comment. */
  @IsOptional()
  @IsMongoId()
  parentId?: string;

  /** @mentions (tags) the composer picker produced. href computed server-side.
   *  Wired into the comment write path by a later task; present now so the DTO
   *  contract is ready. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MentionInputDto)
  mentions?: MentionInputDto[];
}

/**
 * Query for GET `/me/connect/feed/posts/:postId/comments` — one page of a post's
 * comment thread. `cursor` is the previous page's opaque keyset cursor; `limit`
 * is the top-level comment page size, clamped server-side to [1, 50] (default 20).
 */
export class CommentsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** The two feed tabs — `following` (chronological) + `foryou` (ranked). */
export const FEED_TABS = ['following', 'foryou'] as const;
export type FeedTab = (typeof FEED_TABS)[number];

/** Query for GET `/me/connect/feed`. */
export class FeedQueryDto {
  @IsOptional()
  @IsIn(FEED_TABS)
  tab?: FeedTab;

  /**
   * Opaque pagination cursor — the previous page's last entry `postedAt` as
   * an ISO string. Omitted on the first page.
   */
  @IsOptional()
  @IsString()
  cursor?: string;
}

/** Query for GET `/me/connect/feed/saved` (the caller's saved-posts list). */
export class SavedQueryDto {
  /**
   * Opaque pagination cursor: the previous page's last save time as an ISO
   * string. Omitted on the first page.
   */
  @IsOptional()
  @IsString()
  cursor?: string;
}

/**
 * The three profile-Activity views — the caller's own posts, comments, and
 * reactions (LinkedIn-style Activity tab). `posts` + `reactions` return a feed
 * page; `comments` returns the caller's comments with a parent-post preview.
 */
export const ACTIVITY_TYPES = ['posts', 'comments', 'reactions'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Query for GET `/me/connect/feed/activity` (the caller's own activity). */
export class ActivityQueryDto {
  /** Which activity view to return. Defaults to `posts` when omitted. */
  @IsOptional()
  @IsIn(ACTIVITY_TYPES)
  type?: ActivityType;

  /**
   * Opaque pagination cursor: the previous page's last `createdAt` (the post /
   * reaction / comment time, per `type`) as an ISO string. Omitted on page 1.
   */
  @IsOptional()
  @IsString()
  cursor?: string;
}

/**
 * Query for the PUBLIC profile-activity read (`@Public GET
 * /connect/profiles/:slug/activity`) — a profile owner's posts on their public
 * profile, served to anyone (logged-out included). Only `posts` are public:
 * `type` is accepted for URL-contract parity but pinned to `posts` (any other
 * value 400s). Comments + reactions are owner-only and are never served here.
 */
export class PublicActivityQueryDto {
  /** Pinned to `posts` — comments / reactions are never served to a non-owner. */
  @IsOptional()
  @IsIn(['posts'])
  type?: 'posts';

  /**
   * Opaque pagination cursor: the previous page's last post `createdAt` as an
   * ISO string. Omitted on page 1. Validated as ISO-8601 — this is an
   * unauthenticated endpoint, so a malformed cursor is rejected (400) rather
   * than silently treated as page 1.
   */
  @IsOptional()
  @IsISO8601()
  cursor?: string;
}
