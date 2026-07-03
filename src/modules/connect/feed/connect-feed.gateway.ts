import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import type { Server, Socket } from 'socket.io';
import { PostVisibilityService } from './post-visibility.service';
import {
  CONNECT_REALTIME_NAMESPACE,
  FEED_CLIENT_EVENTS,
  FEED_EVENTS,
  SOCKET_TICKET_AUDIENCE,
  postRoom,
  userRoom,
  type NewPostEvent,
  type PostActivityEvent,
} from './feed-realtime';

/** The verified payload of a socket ticket. */
interface SocketTicketClaims {
  sub: string;
}

/** Cap on how many post rooms one socket may watch at once (CN-FEED-18
 *  secondary hardening) — a client that keeps joining without unwatching evicts
 *  its oldest watch instead of holding unbounded room memberships. Generous:
 *  well above a real viewport's worth of on-screen posts. */
const MAX_WATCHED_POSTS_PER_SOCKET = 50;

/** Per-socket state stamped on `client.data`. `watched` preserves insertion
 *  order (a Set does), so the oldest room is the first to evict on overflow. */
interface ConnectSocketData {
  userId?: string;
  watched?: Set<string>;
}

/**
 * `ConnectFeedGateway` — the Connect feed Socket.IO gateway (Phase 3 — B6).
 *
 * Auth: a browser cannot read the httpOnly access-token cookie to authenticate
 * a cross-origin socket, so the client connects with a short-lived **socket
 * ticket** (`POST /me/connect/feed/realtime/ticket`). The handshake verifies
 * the ticket's signature AND its `connect-socket` audience — a ticket can never
 * be replayed as an API token. A bad / missing ticket is disconnected.
 *
 * Rooms: every member joins `user:<id>` (the push surface — new posts from
 * people they follow). A viewer additionally `post:watch`es the posts on
 * screen to get live `post:activity` count updates, and `post:unwatch`es them
 * when they scroll away.
 *
 * Horizontal scale rides the Redis adapter (`RedisIoAdapter`, wired in
 * `main.ts`); a single instance works on the default in-memory adapter, so the
 * gateway has no hard Redis dependency of its own.
 */
@WebSocketGateway({
  namespace: CONNECT_REALTIME_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class ConnectFeedGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ConnectFeedGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    // Shared can-view gate (feed harden Bucket 1, CN-FEED-18). @Optional() so a
    // positional unit-test build with no gate keeps the prior behavior;
    // production DI always injects it. Used to refuse a `post:watch` join for a
    // post the socket's user cannot see.
    @Optional()
    private readonly postVisibility?: PostVisibilityService,
  ) {}

  /** Verify the socket ticket on connect; join the member's user room. */
  handleConnection(client: Socket): void {
    const ticket = this.readTicket(client);
    if (!ticket) {
      client.disconnect(true);
      return;
    }
    try {
      const claims = this.jwtService.verify<SocketTicketClaims>(ticket, {
        audience: SOCKET_TICKET_AUDIENCE,
      });
      if (!claims?.sub) {
        client.disconnect(true);
        return;
      }
      // Stash the id so future messages need no re-verify.
      const data = client.data as ConnectSocketData;
      data.userId = claims.sub;
      data.watched = new Set<string>();
      void client.join(userRoom(claims.sub));
    } catch {
      // Expired / forged / wrong-audience ticket — drop the socket silently.
      client.disconnect(true);
    }
  }

  /**
   * A viewer starts watching a post — join its room for live counts.
   *
   * CN-FEED-18 (feed harden Bucket 1): previously ANY non-empty string joined a
   * room (garbage ids included, and connections-only posts the client could not
   * see — leaking `post:activity` count updates). Now: validate the ObjectId,
   * run the shared view gate for the socket's user, and only then join. A denied
   * join is a silent no-op (never disconnect the whole socket — one denied post
   * must not cost the user their other watched-post rooms). Per-socket room count
   * is capped, evicting the oldest watch on overflow.
   */
  @SubscribeMessage(FEED_CLIENT_EVENTS.watchPost)
  async watchPost(
    @ConnectedSocket() client: Socket,
    @MessageBody() postId: unknown,
  ): Promise<void> {
    if (typeof postId !== 'string' || postId.length === 0) return;
    if (!Types.ObjectId.isValid(postId)) return;
    const data = client.data as ConnectSocketData;
    const userId = data.userId;
    if (!userId) return;
    // Gate the join to a post the user may actually see (production always has
    // the injected service; a positional test build skips the DB read).
    if (this.postVisibility) {
      let allowed = false;
      try {
        allowed = await this.postVisibility.canWatchPostId(new Types.ObjectId(userId), postId);
      } catch (err) {
        // A lookup hiccup must not join the room (fail closed) nor crash the
        // socket — log and no-op the single join.
        this.logger.warn(
          `watchPost gate failed for post ${postId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (!allowed) return;
    }
    void client.join(postRoom(postId));
    const watched = (data.watched ??= new Set<string>());
    watched.add(postId);
    // Evict the oldest watched room(s) once over the cap (insertion order).
    while (watched.size > MAX_WATCHED_POSTS_PER_SOCKET) {
      const oldest = watched.values().next().value as string | undefined;
      if (oldest === undefined) break;
      watched.delete(oldest);
      void client.leave(postRoom(oldest));
    }
  }

  /** A viewer scrolls a post away — leave its room. */
  @SubscribeMessage(FEED_CLIENT_EVENTS.unwatchPost)
  unwatchPost(@ConnectedSocket() client: Socket, @MessageBody() postId: unknown): void {
    if (typeof postId === 'string' && postId.length > 0) {
      void client.leave(postRoom(postId));
      (client.data as ConnectSocketData).watched?.delete(postId);
    }
  }

  // ── Server-side emit API — called by the feed services / fan-out worker ──

  /** Push a new post into every given follower's feed (their user room). */
  emitNewPost(followerIds: string[], payload: NewPostEvent): void {
    if (followerIds.length === 0) return;
    this.safeEmit(() => {
      this.server.to(followerIds.map(userRoom)).emit(FEED_EVENTS.newPost, payload);
    });
  }

  /** Broadcast a post's refreshed counts to everyone watching that post. */
  emitPostActivity(payload: PostActivityEvent): void {
    this.safeEmit(() => {
      this.server.to(postRoom(payload.postId)).emit(FEED_EVENTS.postActivity, payload);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** The ticket from the handshake `auth` payload (or `?ticket=` fallback). */
  private readTicket(client: Socket): string | null {
    const fromAuth = (client.handshake.auth as { ticket?: unknown } | undefined)?.ticket;
    if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;
    const fromQuery = client.handshake.query?.ticket;
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
    return null;
  }

  /**
   * Emit guarded — a realtime delivery failure (adapter hiccup, no listeners)
   * must never bubble into the write path that triggered it.
   */
  private safeEmit(fn: () => void): void {
    try {
      if (this.server) fn();
    } catch (err) {
      this.logger.warn(
        `Connect feed realtime emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
