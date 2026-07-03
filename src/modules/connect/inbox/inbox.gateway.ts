import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import {
  INBOX_EVENTS,
  INBOX_REALTIME_NAMESPACE,
  INBOX_SOCKET_TICKET_AUDIENCE,
  inboxUserRoom,
  type InboxMessageEvent,
  type InboxReadEvent,
} from './inbox-realtime';

/** The verified payload of an inbox socket ticket. */
interface SocketTicketClaims {
  sub: string;
}

/**
 * `InboxGateway` -- the Connect inbox Socket.IO gateway (Phase 7 -- I2).
 *
 * Mirrors `ConnectFeedGateway`: a browser cannot read the httpOnly access-token
 * cookie for a cross-origin socket, so the client connects with a short-lived
 * **inbox socket ticket** (`POST /connect/inbox/realtime/ticket`). The handshake
 * verifies the signature AND the `inbox-socket` audience -- the ticket can never
 * be replayed as an API token or on the feed / notifications gateways. A bad /
 * missing ticket is disconnected.
 *
 * Every member joins `user:<id>` on connect (their delivery surface); a message
 * is emitted to each participant's user room (no per-thread join churn -- the
 * open-DM, high-churn reality). Horizontal scale rides the `RedisIoAdapter`
 * (`main.ts`); a single instance works on the in-memory adapter, so the gateway
 * has no hard Redis dependency. The Redis-Streams fan-out worker that moves
 * this off the hot path arrives in wave I6.
 */
/** Per-user live socket cap on a SINGLE instance (socket-exhaustion guard). A
 *  member with a few tabs / devices is fine; thousands of sockets is abuse.
 *  Per-instance (no Redis dependency); tunable. */
export const INBOX_MAX_SOCKETS_PER_USER = 10;

@WebSocketGateway({
  namespace: INBOX_REALTIME_NAMESPACE,
  cors: { origin: true, credentials: true },
  // The inbox socket is server -> client only (sends go via HTTP POST), so cap
  // any inbound frame defensively at 1 MB.
  maxHttpBufferSize: 1_000_000,
})
export class InboxGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(InboxGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  /** userId -> live socket count on THIS instance (backs the connection cap). */
  private readonly connections = new Map<string, number>();
  private activeConnections = 0;
  private droppedEmits = 0;
  private rejectedConnections = 0;

  constructor(private readonly jwtService: JwtService) {}

  /** Verify the inbox ticket on connect; enforce the per-user cap; join the room. */
  handleConnection(client: Socket): void {
    const ticket = this.readTicket(client);
    if (!ticket) {
      client.disconnect(true);
      return;
    }
    let userId: string;
    try {
      const claims = this.jwtService.verify<SocketTicketClaims>(ticket, {
        audience: INBOX_SOCKET_TICKET_AUDIENCE,
      });
      if (!claims?.sub) {
        client.disconnect(true);
        return;
      }
      userId = claims.sub;
    } catch {
      client.disconnect(true);
      return;
    }

    // Socket-exhaustion guard: cap concurrent sockets per user on this instance.
    const current = this.connections.get(userId) ?? 0;
    if (current >= INBOX_MAX_SOCKETS_PER_USER) {
      this.rejectedConnections += 1;
      this.logger.warn(`inbox socket cap (${current}) hit for ${userId}; rejecting`);
      client.disconnect(true);
      return;
    }
    this.connections.set(userId, current + 1);
    this.activeConnections += 1;
    (client.data as { userId?: string }).userId = userId;
    void client.join(inboxUserRoom(userId));
  }

  /** Free the member's connection slot when a socket closes. */
  handleDisconnect(client: Socket): void {
    const userId = (client.data as { userId?: string }).userId;
    if (!userId) return;
    const current = this.connections.get(userId) ?? 0;
    if (current <= 1) this.connections.delete(userId);
    else this.connections.set(userId, current - 1);
    if (this.activeConnections > 0) this.activeConnections -= 1;
  }

  /** Realtime health counters (scrape hook for metrics / the I6 load test). */
  getStats(): {
    activeConnections: number;
    distinctUsers: number;
    droppedEmits: number;
    rejectedConnections: number;
  } {
    return {
      activeConnections: this.activeConnections,
      distinctUsers: this.connections.size,
      droppedEmits: this.droppedEmits,
      rejectedConnections: this.rejectedConnections,
    };
  }

  // ── Server-side emit API -- called by InboxService ───────────────────────

  /** Deliver a message to the given participant user rooms (best-effort). */
  emitMessage(recipientUserIds: string[], payload: InboxMessageEvent): void {
    if (recipientUserIds.length === 0) return;
    this.safeEmit(() => {
      this.server.to(recipientUserIds.map(inboxUserRoom)).emit(INBOX_EVENTS.message, payload);
    });
  }

  /** Notify a recipient that their thread list row changed (unread / last msg). */
  emitThreadUpdated(recipientUserId: string, threadId: string): void {
    this.safeEmit(() => {
      this.server.to(inboxUserRoom(recipientUserId)).emit(INBOX_EVENTS.threadUpdated, { threadId });
    });
  }

  /** Broadcast a read watermark to the other participant(s). */
  emitRead(recipientUserIds: string[], payload: InboxReadEvent): void {
    if (recipientUserIds.length === 0) return;
    this.safeEmit(() => {
      this.server.to(recipientUserIds.map(inboxUserRoom)).emit(INBOX_EVENTS.read, payload);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private readTicket(client: Socket): string | null {
    const fromAuth = (client.handshake.auth as { ticket?: unknown } | undefined)?.ticket;
    if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;
    const fromQuery = client.handshake.query?.ticket;
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
    return null;
  }

  /** A realtime failure must never bubble into the write path that triggered it. */
  private safeEmit(fn: () => void): void {
    try {
      if (this.server) fn();
    } catch (err) {
      this.droppedEmits += 1;
      this.logger.warn(
        `Connect inbox realtime emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
