import { Injectable } from '@nestjs/common';
import { NotificationsGateway } from '../notifications.gateway';
import type { NotificationChannel, ChannelSendInput } from './notification-channel.interface';

/**
 * `InPlatformChannel` — the bell + notifications-center + Socket.IO push
 * surface. Persistence is the orchestrator's job (`NotificationsService`
 * already wrote the envelope before this channel runs); this channel
 * only emits the realtime event so connected clients refresh without
 * waiting for the 60-s polling fallback to tick.
 */
@Injectable()
export class InPlatformChannel implements NotificationChannel {
  readonly name = 'in_platform' as const;

  constructor(private readonly gateway: NotificationsGateway) {}

  /** Always available — in-platform is the baseline channel. */
  // Non-async (no `await` — the gateway emit is synchronous) but returns a
  // Promise to satisfy the `NotificationChannel` contract.

  isAvailable(_recipientId: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  send(input: ChannelSendInput): Promise<void> {
    this.gateway.emitNotificationCreated(input.recipientId, {
      notificationId: input.notificationId,
      category: input.category,
      title: input.title,
      message: input.message,
      actorId: input.actorId,
      aggregatedCount: input.aggregatedCount,
      createdAt: new Date().toISOString(),
    });
    return Promise.resolve();
  }
}
