/**
 * ManekHR Connect — Feed realtime contract (Phase 3 — Feed, B6).
 *
 * Shared constants + payload shapes for the Socket.IO layer. The gateway and
 * the web `useConnectSocket` client both import from here so the event names
 * and payloads never drift.
 */

/** Socket.IO namespace the Connect feed gateway serves. */
export const CONNECT_REALTIME_NAMESPACE = '/connect';

/**
 * `aud` claim stamped on a socket ticket. Verified on connect so a socket
 * ticket can never be replayed as an API access token (or vice versa) even
 * though both are signed with the same secret.
 */
export const SOCKET_TICKET_AUDIENCE = 'connect-socket';

/** Socket ticket TTL — short: the client fetches a fresh one on every connect. */
export const SOCKET_TICKET_TTL = '120s';

/** Server → client events. */
export const FEED_EVENTS = {
  /** A followed author published a post — sent to a follower's user room. */
  newPost: 'feed:new-post',
  /** A post's reaction / comment counts changed — sent to that post's room. */
  postActivity: 'post:activity',
} as const;

/** Client → server events — a viewer (un)watches a post for live counts. */
export const FEED_CLIENT_EVENTS = {
  watchPost: 'post:watch',
  unwatchPost: 'post:unwatch',
} as const;

/** `feed:new-post` payload. */
export interface NewPostEvent {
  postId: string;
  authorId: string;
}

/** `post:activity` payload — the post's live counts. */
export interface PostActivityEvent {
  postId: string;
  reactionCount: number;
  commentCount: number;
}

/** The `user:<id>` room a member joins on connect (push surface). */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** The `post:<id>` room a viewer joins to watch a post's live counts. */
export function postRoom(postId: string): string {
  return `post:${postId}`;
}
