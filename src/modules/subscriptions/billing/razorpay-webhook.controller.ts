import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../../common/decorators/public.decorator';
import { RazorpayWebhookService } from './services/razorpay-webhook.service';

/**
 * Platform-level Razorpay webhook receiver — D1d.
 *
 * URL: POST /razorpay/webhook  (excluded from /api global prefix in main.ts)
 *
 * Distinct from `RazorpayWebhookController` under
 * `modules/finance/sales/payment-link/`, which handles per-firm
 * customer-invoice payment-link webhooks. THIS controller handles
 * ManekHR's own SaaS subscription billing events: `payment.captured`,
 * `payment.failed`, `refund.created`, `subscription.charged/halted/
 * cancelled/activated`.
 *
 * Auth model:
 *   - @Public(): JWT bypassed — Razorpay calls this, not a logged-in user.
 *   - HMAC-SHA256 signature verification IS the auth: only the holder of
 *     `RAZORPAY_PLATFORM_WEBHOOK_SECRET` can produce a valid signature.
 *   - Returns 200 once the raw event is persisted, even if a handler
 *     errors out — Razorpay retries non-2xx and a buggy handler would
 *     loop the same broken event forever. Failed events are flagged
 *     `status='failed'` on the row for admin replay.
 *   - Returns 401 on missing/invalid signature so an attacker learns
 *     nothing about which events we accept.
 */
@Controller('razorpay/webhook')
export class RazorpayPlatformWebhookController {
  private readonly logger = new Logger(RazorpayPlatformWebhookController.name);

  constructor(private readonly webhookService: RazorpayWebhookService) {}

  @Post()
  @Public()
  @HttpCode(200)
  async handle(
    @Headers('x-razorpay-signature') signature: string,
    @Headers('x-razorpay-event-id') eventId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (!signature) {
      throw new UnauthorizedException('Missing x-razorpay-signature header');
    }

    const rawBody = req.rawBody?.toString('utf-8') ?? '';
    if (!rawBody) {
      throw new UnauthorizedException('Empty request body');
    }

    const result = await this.webhookService.ingest(rawBody, signature, eventId);

    if (!result.ok) {
      // Don't 200 a bad-signature attempt — Razorpay never sees these in
      // practice, and 401 surfaces it in monitoring if the secret rotates
      // out of sync.
      throw new UnauthorizedException('Webhook signature invalid');
    }

    return { received: true };
  }
}
