import { Injectable, Logger } from '@nestjs/common';
import { UserDevicesService } from '../../user-devices/user-devices.service';
import type { NotificationChannel, ChannelSendInput } from './notification-channel.interface';

/**
 * `BrowserPushChannel` — Web Push via FCM to the browser / installed PWA
 * (desktop + Android). Reuses the `user-devices` registry (web-platform
 * tokens) + the shared `firebase-admin` sender. Cross-module:
 * notifications dispatch -> UserDevicesService.pushUserWeb -> PushAdapter (FCM).
 *
 * `isAvailable` is true iff the recipient has at least one registered web
 * device, so the dispatcher skips browser push for users who never opted in.
 */
@Injectable()
export class BrowserPushChannel implements NotificationChannel {
  private readonly logger = new Logger(BrowserPushChannel.name);
  readonly name = 'browser_push' as const;

  constructor(private readonly userDevices: UserDevicesService) {}

  async isAvailable(recipientId: string): Promise<boolean> {
    const devices = await this.userDevices.listWebDevices(recipientId);
    return devices.length > 0;
  }

  async send(input: ChannelSendInput): Promise<void> {
    // Deep-link: prefer an explicit metadata.link (ERP rows carry one); else
    // land on the notifications centre. FCM `data` values must be strings.
    const metaLink =
      input.metadata && typeof (input.metadata as { link?: unknown }).link === 'string'
        ? (input.metadata as { link: string }).link
        : '/connect/notifications';

    await this.userDevices.pushUserWeb(input.recipientId, {
      title: input.title,
      body: input.message,
      data: {
        notificationId: input.notificationId,
        category: input.category,
        link: metaLink,
      },
    });
  }
}
