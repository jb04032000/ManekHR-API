import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

/**
 * Firebase Cloud Messaging sender for user-targeted push (workspace invites,
 * permission-change alerts, etc.). Relocated from the deleted Finance module's
 * reminders/adapters folder (2026-07-04) — this class was always general-purpose
 * (see `sendUserPush`), just colocated with Finance's payment-reminder channels.
 * Only consumer: UserDevicesService.pushUser().
 */
@Injectable()
export class PushAdapterService implements OnModuleInit {
  private readonly logger = new Logger(PushAdapterService.name);
  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const projectId = this.configService.get<string>('app.firebase.projectId');
    const clientEmail = this.configService.get<string>('app.firebase.clientEmail');
    const privateKey = this.configService.get<string>('app.firebase.privateKey');
    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn('Firebase config missing — PushAdapterService disabled');
      return;
    }
    if (admin.apps.length) {
      this.initialized = true;
      return;
    }
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
      this.initialized = true;
      this.logger.log('Firebase admin initialized');
    } catch (err: any) {
      this.logger.error(`Firebase init failed: ${err?.message ?? err}`);
    }
  }

  private maskToken(token: string): string {
    if (!token || token.length < 8) return '***';
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
  }

  /**
   * Send a user-targeted push (workspace invites, anomaly alerts, etc.).
   * Caller controls title / body / data payload directly. Errors are surfaced
   * so the caller can prune dead tokens (`messaging/registration-token-not-registered`).
   */
  async sendUserPush(input: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
    /**
     * Web (browser) push must be DATA-ONLY. A `notification` payload makes FCM
     * auto-display a notification AND our firebase-messaging-sw.js
     * onBackgroundMessage handler shows one too -> the user sees it twice.
     * Data-only sends exactly one (the SW reads title/body from `data`). Mobile
     * leaves this false so the system tray still gets a notification payload.
     * Keep in sync with public/firebase-messaging-sw.js + lib/push/firebase-messaging.ts.
     */
    dataOnly?: boolean;
  }): Promise<{
    success: boolean;
    messageId?: string;
    errorCode?: string;
    errorMessage?: string;
  }> {
    if (!this.initialized) {
      return {
        success: false,
        errorCode: 'not_initialized',
        errorMessage: 'firebase-admin not initialized',
      };
    }
    try {
      const messageId = input.dataOnly
        ? await admin.messaging().send({
            token: input.token,
            // Data-only (browser): title/body ride in `data` so ONLY our service
            // worker renders the notification (no FCM auto-display -> no duplicate).
            data: { ...(input.data ?? {}), title: input.title, body: input.body },
            // Web push defaults to NORMAL urgency, which Android delivers as a
            // silent tray entry (no heads-up popup) and may defer on doze.
            // Urgency high = wake the device + banner-style display, matching
            // the mobile branch's android priority high below.
            webpush: { headers: { Urgency: 'high' } },
          })
        : await admin.messaging().send({
            token: input.token,
            notification: { title: input.title, body: input.body },
            data: input.data ?? {},
            android: { priority: 'high' },
            apns: { payload: { aps: { sound: 'default' } } },
          });
      return { success: true, messageId };
    } catch (err: any) {
      const code = err?.errorInfo?.code ?? err?.code ?? 'unknown';
      const errMsg = `${code}: ${err?.message ?? ''}`.slice(0, 500);
      this.logger.error(`User push send failed to ${this.maskToken(input.token)}: ${errMsg}`);
      return { success: false, errorCode: String(code), errorMessage: errMsg };
    }
  }
}
