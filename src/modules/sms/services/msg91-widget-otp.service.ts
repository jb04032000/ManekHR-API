import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { env } from '../../../config/env';

const VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';

interface Msg91VerifyResponse {
  type: 'success' | 'error';
  message: string;
}

/**
 * Server-side half of the MSG91 OTP Widget flow. The browser (via MSG91's
 * JS SDK, see web `lib/auth/use-msg91-widget.ts`) sends + verifies the OTP
 * itself and hands us a one-time access-token; this confirms that token is
 * genuine before we trust the mobile number it claims. Cross-module:
 * consumed by SmsOtpService's matchOtp helper for every widget-channel
 * verify call.
 */
@Injectable()
export class Msg91WidgetOtpService {
  private readonly logger = new Logger(Msg91WidgetOtpService.name);

  async verifyAccessToken(accessToken: string): Promise<{ mobile: string } | null> {
    try {
      const res = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          authkey: env.msg91.authKey,
          'access-token': accessToken,
        }),
      });
      const data = (await res.json()) as Msg91VerifyResponse;
      if (data.type !== 'success' || !data.message) {
        this.logger.warn(`[WIDGET OTP] verify failed type=${data.type}`);
        return null;
      }
      return { mobile: data.message };
    } catch (err) {
      Sentry.captureException(err, {
        tags: { module: 'sms', op: 'msg91Widget.verifyAccessToken' },
      });
      this.logger.warn(`[WIDGET OTP] verify request errored: ${(err as Error)?.message}`);
      return null;
    }
  }
}
