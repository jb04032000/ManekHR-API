import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, ChannelSendInput } from './notification-channel.interface';

/**
 * `MobilePushChannel` — scaffold for FCM / APNs push notifications to the
 * future ManekHR mobile app. Implementation deferred until the mobile app
 * lands + provider keys (FCM service account / APNs auth key) are provisioned.
 *
 * Contract locked NOW so the rest of the dispatch pipeline can be built
 * against the final shape. When the mobile app ships, this class swaps
 * `isAvailable` to "does the user have a registered FCM token?" and
 * `send` to "POST to FCM / APNs". No changes elsewhere.
 *
 * Until then: `isAvailable` returns false so the dispatcher skips this
 * channel — no NotImplementedException thrown into the orchestrator's
 * error path. The channel is registered for telemetry / preferences-UI
 * column wiring.
 */
@Injectable()
export class MobilePushChannel implements NotificationChannel {
  private readonly logger = new Logger(MobilePushChannel.name);
  readonly name = 'mobile_push' as const;

  // Non-async (no `await` in a stub body) but returns a Promise to satisfy the
  // `NotificationChannel` contract.

  isAvailable(_recipientId: string): Promise<boolean> {
    // TODO(phase-mobile): look up the user's registered FCM / APNs tokens
    // and return true iff at least one is active. For now, the channel is
    // always unavailable — the dispatcher will skip it.
    return Promise.resolve(false);
  }

  send(input: ChannelSendInput): Promise<void> {
    // Never called while `isAvailable` returns false. Log + reject on the
    // off-chance a future caller invokes directly — fail fast so the
    // missing impl is loud rather than silent (the dispatcher catches it).
    this.logger.error(
      `MobilePushChannel.send called but no provider is wired (notification ${input.notificationId})`,
    );
    return Promise.reject(new Error('MobilePushChannel: provider not wired'));
  }
}
