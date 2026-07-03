/**
 * ManekHR Connect -- Inbox realtime contract (Phase 7 -- I2).
 *
 * Shared constants + payload shapes for the Socket.IO layer. The gateway and
 * the web inbox-socket client both import from here so event names + payloads
 * never drift. Its own namespace + ticket audience (distinct from feed /
 * notifications) so an inbox ticket can never be replayed on another gateway.
 *
 * The socket is a best-effort accelerator over the durable Mongo store: a
 * dropped emit is recovered by the since-cursor catch-up (`seq`), never lost.
 */

/** Socket.IO namespace the Connect inbox gateway serves. */
export const INBOX_REALTIME_NAMESPACE = '/inbox';

/** `aud` claim stamped on an inbox socket ticket (never valid elsewhere). */
export const INBOX_SOCKET_TICKET_AUDIENCE = 'inbox-socket';

/** Ticket TTL -- short; the client mints a fresh one on every (re)connect. */
export const INBOX_SOCKET_TICKET_TTL = '120s';

/** Server -> client events. */
export const INBOX_EVENTS = {
  /** A new message arrived -- sent to each participant's user room. */
  message: 'inbox:message',
  /** A participant read up to a seq -- sent to the thread's other participant. */
  read: 'inbox:read',
  /** Thread list metadata changed (unread / last message) for a recipient. */
  threadUpdated: 'inbox:thread-updated',
} as const;

/** `inbox:message` payload -- the delivered message (the client dedups by id). */
export interface InboxMessageEvent {
  threadId: string;
  messageId: string;
  senderUserId: string | null;
  kind: string;
  body: string;
  seq: number;
  createdAt: string;
}

/** `inbox:read` payload -- a participant's read watermark. */
export interface InboxReadEvent {
  threadId: string;
  readerUserId: string;
  upToSeq: number;
}

/** The `user:<id>` room a member joins on connect (their delivery surface). */
export function inboxUserRoom(userId: string): string {
  return `user:${userId}`;
}
