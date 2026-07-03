import type { NotificationCategory } from '../notification-categories';

/**
 * Channel adapter contract.
 *
 * A `NotificationChannel` is responsible for delivering ONE notification
 * to ONE recipient over ONE delivery surface (in-platform socket + DB,
 * mobile push via FCM/APNs, browser push via Web Push, email digest, etc.).
 *
 * The `NotificationsService.dispatch` orchestrator owns:
 *  - Resolving the recipient's per-channel preferences.
 *  - Persisting a single `Notification` envelope (regardless of how many
 *    channels fire — channels see the persisted doc and react).
 *  - Fanning out to every enabled channel concurrently with isolated
 *    error handling.
 *
 * A channel adapter owns:
 *  - Knowing whether it CAN deliver right now (`isAvailable` — e.g. mobile
 *    push returns false when the user has no registered push token).
 *  - Performing the delivery (`send`).
 *  - Surfacing failure as a thrown error (orchestrator logs + isolates).
 *
 * New channel = new class implementing this interface + add it to the
 * registry in `NotificationsModule`. No changes to dispatch sites.
 */
export interface NotificationChannel {
  /** Stable channel identifier — used in `Notification.deliveredChannels`
   *  audit trail and the user preferences map. */
  readonly name: 'in_platform' | 'mobile_push' | 'browser_push';

  /**
   * Whether the channel can deliver to this recipient right now. The
   * dispatcher skips the channel when this returns false, without
   * counting it as a failure. (Mobile push without a registered token,
   * browser push without a subscription, etc.)
   */
  isAvailable(recipientId: string): Promise<boolean>;

  /**
   * Deliver the notification. The persisted envelope is passed so the
   * channel can reference its `_id`, `category`, `title`, `message`,
   * `actorId`, `entityType`, `entityId`, `metadata`.
   */
  send(input: ChannelSendInput): Promise<void>;
}

export interface ChannelSendInput {
  notificationId: string;
  recipientId: string;
  category: NotificationCategory;
  title: string;
  message: string;
  actorId: string | null;
  /** Distinct actors folded into this row (batching, §12.3); `1` for a singleton. */
  aggregatedCount: number;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
}
