/**
 * Notifications realtime contract — shared between the gateway and the
 * web `useNotificationSocket` client so event names + payloads never drift.
 *
 * Dedicated namespace (NOT piggybacked on the Connect feed gateway) so
 * the two subsystems stay independently authed + permissioned. Same
 * socket-ticket auth pattern as Feed (`connect/feed/feed-realtime.ts`).
 */

import type { NotificationCategory } from './notification-categories';

/** Socket.IO namespace the notifications gateway serves. */
export const NOTIFICATIONS_REALTIME_NAMESPACE = '/notifications';

/** `aud` claim stamped on a notifications-socket ticket. */
export const NOTIFICATIONS_SOCKET_TICKET_AUDIENCE = 'notifications-socket';

/** Short ticket TTL — client mints fresh on each (re)connect. */
export const NOTIFICATIONS_SOCKET_TICKET_TTL = '120s';

/** Server → client events. */
export const NOTIFICATION_EVENTS = {
  /** A new notification was persisted for this user. Bell + center refresh. */
  created: 'notification:created',
  /** The user's unread count changed (mark-read elsewhere, etc.). */
  unreadCountChanged: 'notification:unread-count-changed',
} as const;

/** `notification:created` payload — slim summary so the FE can decide
 *  whether to refetch the list or just bump the count.  */
export interface NotificationCreatedEvent {
  notificationId: string;
  category: NotificationCategory;
  title: string;
  message: string;
  actorId: string | null;
  /** Distinct actors folded into this row (batching, §12.3); `1` for a singleton. */
  aggregatedCount: number;
  createdAt: string;
}

export interface NotificationUnreadCountChangedEvent {
  count: number;
}

/** The `user:<id>` room the recipient joins on connect. */
export function notificationsUserRoom(userId: string): string {
  return `user:${userId}`;
}
