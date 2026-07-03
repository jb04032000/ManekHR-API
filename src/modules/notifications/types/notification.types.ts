import { Notification } from '../schemas/notification.schema';

export interface NotificationResult {
  notification: Notification;
}

/**
 * Recognised values for `metadata.category` on a Notification document.
 *
 * The category is stored as a free-form string in metadata, but all
 * first-party producers MUST use one of these enum members so that the
 * /me/notifications `?category=` filter and the front-end bell tabs work
 * consistently.
 *
 * Adding a new notification type:
 *   1. Add a member here.
 *   2. Pass `category: NotificationCategory.<NEW>` in the `metadata` object
 *      when calling `NotificationsService.createNotification(...)`.
 */
export enum NotificationCategory {
  INVITE_RECEIVED = 'INVITE_RECEIVED',
  ATTENDANCE_DEFAULTER = 'ATTENDANCE_DEFAULTER',
  PERMISSIONS_UPDATED = 'PERMISSIONS_UPDATED',
  ROLE_CHANGED = 'ROLE_CHANGED',
}
