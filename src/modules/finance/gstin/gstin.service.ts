import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { trace } from '@opentelemetry/api';
import { decryptSmtpPassword } from '../../../common/utils/crypto-utils';
import { env } from '../../../config/env';
import { withFinanceSpan } from '../common/finance-observability';
import { Firm } from '../firms/firm.schema';
import { GstinInfo } from './gstin-provider.interface';
import { GstinLookupCache } from './gstin-lookup-cache.schema';
import { SurepassProvider } from './providers/surepass.provider';
import { validateGstin } from './gstin-validator';

@Injectable()
export class GstinService {
  // Platform-bar observability: shared finance tracer (mirrors Gstr1Service / Gstr3bService).
  // lookup is an external-provider read -> span only (no PostHog write event, no userId here).
  // PII rule: NEVER tag the raw GSTIN. We tag only the 2-char state-code prefix (coarse
  // geography, non-identifying) and a byok boolean (which key path was used).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    private readonly surepass: SurepassProvider,
    @InjectModel(GstinLookupCache.name)
    private readonly cacheModel: Model<GstinLookupCache>,
  ) {}

  async lookup(gstin: string, firm?: Firm): Promise<GstinInfo | null> {
    // Full offline validation (format + state code + check digit) before spending a paid
    // provider call on a typo'd GSTIN.
    const check = validateGstin(gstin);
    if (!check.valid) {
      throw new BadRequestException(
        check.reason === 'check_digit'
          ? 'Invalid GSTIN: the check digit does not match (likely a typo).'
          : check.reason === 'state_code'
            ? 'Invalid GSTIN: unknown GST state code.'
            : 'Invalid GSTIN format. Must be 15 characters: 2 digits + 5 letters + 4 digits + letter + alphanumeric + Z + alphanumeric.',
      );
    }

    const byok =
      firm?.gstinProviderConfig?.mode === 'byok' &&
      Boolean(firm.gstinProviderConfig.encryptedApiKey);

    return withFinanceSpan(
      this.tracer,
      'finance.lookupGstin',
      { stateCode: gstin.slice(0, 2), byok },
      async () => {
        // D6: serve a prior successful lookup from cache - never spend another paid provider call
        // on the same GSTIN (entries TTL-refresh every 30 days so status changes update).
        const cached = await this.cacheModel.findOne({ gstin }).lean();
        if (cached?.info) return cached.info as unknown as GstinInfo;

        let apiKey: string | undefined;
        if (byok && firm?.gstinProviderConfig?.encryptedApiKey) {
          apiKey = decryptSmtpPassword(firm.gstinProviderConfig.encryptedApiKey);
        }
        const effectiveKey = apiKey ?? env.surepass.apiKey;
        // D6: no provider configured -> degrade gracefully to manual entry (null) instead of
        // throwing SUREPASS_NOT_CONFIGURED. The UI then shows "enter details manually".
        if (!effectiveKey) return null;

        const info = await this.surepass.fetchByGstin(gstin, effectiveKey);
        // Cache the successful lookup (best-effort; a cache-write error must not fail the lookup).
        await this.cacheModel
          .updateOne({ gstin }, { $set: { gstin, info, fetchedAt: new Date() } }, { upsert: true })
          .catch(() => undefined);
        return info;
      },
    );
  }
}
