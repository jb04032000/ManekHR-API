import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  NOTIFICATIONS_REALTIME_NAMESPACE,
  NOTIFICATIONS_SOCKET_TICKET_AUDIENCE,
  NOTIFICATION_EVENTS,
  notificationsUserRoom,
  type NotificationCreatedEvent,
  type NotificationUnreadCountChangedEvent,
} from './notifications-realtime';

interface SocketTicketClaims {
  sub: string;
}

/**
 * `NotificationsGateway` — dedicated Socket.IO namespace for in-platform
 * notification push (Phase 7a). Mirrors the Connect feed gateway pattern
 * (`feed-realtime.gateway.ts`) — short-lived socket-ticket auth, `user:<id>`
 * rooms, Redis adapter via `main.ts`. Lives on a separate namespace
 * (`/notifications`) so notifications + feed don't share a socket or auth
 * surface.
 *
 * The in-platform channel calls `emitNotificationCreated(...)` after
 * persisting a Notification doc. Bell + center FE subscribe and refresh.
 */
@WebSocketGateway({
  namespace: NOTIFICATIONS_REALTIME_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class NotificationsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly jwtService: JwtService) {}

  /** Verify the socket ticket on connect; join the recipient's user room. */
  handleConnection(client: Socket): void {
    const ticket = this.readTicket(client);
    if (!ticket) {
      client.disconnect(true);
      return;
    }
    try {
      const claims = this.jwtService.verify<SocketTicketClaims>(ticket, {
        audience: NOTIFICATIONS_SOCKET_TICKET_AUDIENCE,
      });
      if (!claims?.sub) {
        client.disconnect(true);
        return;
      }
      (client.data as { userId?: string }).userId = claims.sub;
      void client.join(notificationsUserRoom(claims.sub));
    } catch {
      client.disconnect(true);
    }
  }

  /** Push a new notification to the recipient's user room. */
  emitNotificationCreated(recipientId: string, payload: NotificationCreatedEvent): void {
    this.safeEmit(() => {
      this.server.to(notificationsUserRoom(recipientId)).emit(NOTIFICATION_EVENTS.created, payload);
    });
  }

  /** Broadcast the recipient's refreshed unread count. */
  emitUnreadCountChanged(recipientId: string, payload: NotificationUnreadCountChangedEvent): void {
    this.safeEmit(() => {
      this.server
        .to(notificationsUserRoom(recipientId))
        .emit(NOTIFICATION_EVENTS.unreadCountChanged, payload);
    });
  }

  /** Ticket from the handshake `auth` payload (or `?ticket=` fallback). */
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
        `Notifications realtime emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
