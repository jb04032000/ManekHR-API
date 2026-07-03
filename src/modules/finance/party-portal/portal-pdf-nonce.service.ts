import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { trace } from '@opentelemetry/api';
import Redis from 'ioredis';
import { createHmac, randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
// Platform-bar observability: span-ONLY (public token flow, no userId, no PostHog).
// PII rule: never emit the nonce, signature, or HMAC secret - invoiceId/partyId only.
import { withFinanceSpan } from '../common/finance-observability';

export interface PdfNonceResult {
  url: string;
  expiresAt: Date;
}

/**
 * PortalPdfNonceService — one-time HMAC-signed sub-URLs for PDF download
 * (D-24, threat T-16-04-05).
 *
 * Why: the master JWT must NEVER appear in PDF download links (forwardable).
 * Instead, on demand, we issue a 15-minute HMAC URL whose nonce is stored in
 * Redis SETEX 900. First consume → mark 'used'. Second consume → 410 Gone.
 *
 * Key shape: `portal:pdf-nonce:{nonce}` → 'pending' | 'used' (TTL 900 s).
 *
 * Constructor uses parameter-property injection per the explicit
 * acceptance criterion in the plan: `constructor(private readonly cfg: ConfigService)`.
 */
@Injectable()
export class PortalPdfNonceService {
  private readonly logger = new Logger(PortalPdfNonceService.name);
  private readonly tracer = trace.getTracer('finance');

  constructor(
    private readonly cfg: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private secret(): string {
    return this.cfg.getOrThrow<string>('PORTAL_TOKEN_SECRET');
  }

  /**
   * sign — produces a one-time URL.
   */
  async sign(invoiceId: string, partyId: string): Promise<PdfNonceResult> {
    return withFinanceSpan(
      this.tracer,
      'finance.portalSignPdfNonce',
      { invoiceId, partyId },
      async () => {
        const nonce = randomUUID();
        const exp = Math.floor(Date.now() / 1000) + 900; // 15 min
        const payload = `${invoiceId}.${partyId}.${nonce}.${exp}`;
        const sig = createHmac('sha256', this.secret()).update(payload).digest('hex');
        await this.redis.setex(`portal:pdf-nonce:${nonce}`, 900, 'pending');
        return {
          url: `/portal/invoices/${invoiceId}/pdf?sig=${sig}&exp=${exp}&n=${nonce}`,
          expiresAt: new Date(exp * 1000),
        };
      },
    );
  }

  /**
   * consumeNonce — verifies HMAC + flips state to 'used'.
   *  - exp expired → 401
   *  - sig mismatch → 401
   *  - nonce missing or already used → 410
   */
  async consumeNonce(
    invoiceId: string,
    partyId: string,
    sig: string,
    exp: string,
    n: string,
  ): Promise<void> {
    // Span-only wrap. The nonce (n) and signature (sig) are secrets - NOT emitted;
    // span carries invoiceId/partyId only.
    return withFinanceSpan(
      this.tracer,
      'finance.portalConsumePdfNonce',
      { invoiceId, partyId },
      async () => {
        const expSec = Number(exp);
        if (!Number.isFinite(expSec) || Date.now() / 1000 > expSec) {
          throw new UnauthorizedException('Sub-URL expired');
        }
        const expected = createHmac('sha256', this.secret())
          .update(`${invoiceId}.${partyId}.${n}.${exp}`)
          .digest('hex');
        if (sig !== expected) {
          throw new UnauthorizedException('Invalid signature');
        }
        const status = await this.redis.get(`portal:pdf-nonce:${n}`);
        if (!status) {
          throw new HttpException('Sub-URL expired or already used', HttpStatus.GONE);
        }
        if (status === 'used') {
          throw new HttpException('Sub-URL already used', HttpStatus.GONE);
        }
        // Keep the same TTL so a third attempt still sees 'used' for diagnostic
        // replay detection rather than 'missing' (404-ish) afterwards.
        await this.redis.set(`portal:pdf-nonce:${n}`, 'used', 'KEEPTTL' as any);
      },
    );
  }
}
