/**
 * Inbox -> domain events. The inbox emits these when a CONTEXT thread (an
 * inquiry / application / quote) is read or replied to, so the owning module can
 * sync its own entity status WITHOUT the inbox importing it (decoupled via the
 * global EventEmitter, mirroring `connect-listing.events.ts`). No cycle.
 */

export const CONNECT_INBOX_THREAD_ACTIVITY = 'connect.inbox.thread_activity';

export interface InboxThreadActivityEvent {
  /** The wrapped entity type, e.g. `Inquiry`. */
  contextEntityType: string;
  /** The wrapped entity id. */
  contextEntityId: string;
  /** Who acted (read / sent). */
  actorId: string;
  /** `read` = the actor opened the thread; `reply` = the actor sent a message. */
  kind: 'read' | 'reply';
}
