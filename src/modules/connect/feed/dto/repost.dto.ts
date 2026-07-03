import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /me/connect/feed/posts/:postId/repost`. A bare repost sends no
 * body; a quote-repost includes the caller's `quote` commentary (stored as the
 * repost's own body). A plain repost (no quote) is idempotent per (user, post).
 */
export class RepostDto {
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  quote?: string;
}
