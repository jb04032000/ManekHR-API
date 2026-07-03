import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ConnectReferralConfig,
  type ConnectReferralConfigDocument,
  type ConnectReferralConfigView,
  CONNECT_REFERRAL_DEFAULTS,
} from '../schemas/connect-referral-config.schema';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import type { AdminReferralConfigDto } from '../dto/admin-referral-config.dto';

const SINGLETON_KEY = 'default';

// Hard safety rails. Admin tunes live values WITHIN these (no deploy).
const GUARDRAILS = {
  creditMax: 10_000,
  holdbackMax: 90,
  capMax: 1_000_000,
  ceilingMax: 10_000_000,
  budgetMax: 1_000_000_000,
  velocityMax: 1_000,
} as const;

/**
 * Reads + writes the single ConnectReferralConfig lever doc. Mirrors
 * ConnectPricingConfigService (60s cache busted on write, audited writes,
 * upsert-on-read). Injected by ReferralService + the admin controller.
 * Cross-module links: ConnectReferralConfig schema; AuditService (AppModule.ADS);
 *   AdminReferralConfigDto (body shape). Watch: cache is module-instance-scoped --
 *   in a multi-replica deploy each pod caches independently (max 60s stale).
 */
@Injectable()
export class ConnectReferralConfigService {
  private readonly logger = new Logger(ConnectReferralConfigService.name);
  private static readonly CACHE_TTL_MS = 60_000;
  private cached: { view: ConnectReferralConfigView; at: number } | null = null;

  constructor(
    @InjectModel(ConnectReferralConfig.name)
    private readonly model: Model<ConnectReferralConfigDocument>,
    private readonly audit: AuditService,
  ) {}

  /**
   * Returns the live referral config view, upserting the default singleton on
   * first read so a fresh DB behaves exactly like the shipped defaults.
   * Served from the 60s in-process cache when warm.
   */
  async getConfig(nowMs: number = Date.now()): Promise<ConnectReferralConfigView> {
    if (this.cached && nowMs - this.cached.at < ConnectReferralConfigService.CACHE_TTL_MS) {
      return this.cached.view;
    }
    const doc = await this.model
      .findOneAndUpdate(
        { key: SINGLETON_KEY },
        { $setOnInsert: { key: SINGLETON_KEY, ...CONNECT_REFERRAL_DEFAULTS } },
        { new: true, upsert: true },
      )
      .exec();
    const view = this.toView(doc);
    this.cached = { view, at: nowMs };
    return view;
  }

  /**
   * Admin update. Validates all fields against the hard guardrails, writes,
   * busts the cache, and audits under AppModule.ADS. Returns the new live view.
   */
  async updateConfig(
    dto: AdminReferralConfigDto,
    adminUserId: string,
  ): Promise<ConnectReferralConfigView> {
    const next = this.validate(dto);
    const doc = await this.model
      .findOneAndUpdate(
        { key: SINGLETON_KEY },
        { $set: next, $setOnInsert: { key: SINGLETON_KEY } },
        { new: true, upsert: true },
      )
      .exec();
    this.cached = null;
    // AppModule.ADS is intentional: referral credits are ads-wallet credits; the wallet
    // admin-adjust also audits under ADS. entityType:'ConnectReferralConfig' disambiguates.
    await this.audit.logEvent({
      module: AppModule.ADS,
      entityType: 'ConnectReferralConfig',
      entityId: String(doc._id),
      action: 'referral_config_updated',
      actorId: adminUserId,
      meta: { ...next },
    });
    this.logger.log(`Connect referral config updated by admin=${adminUserId}`);
    return this.toView(doc);
  }

  private toView(doc: ConnectReferralConfigDocument): ConnectReferralConfigView {
    return {
      enabled: doc.enabled,
      referrerCredits: doc.referrerCredits,
      refereeCredits: doc.refereeCredits,
      holdbackDays: doc.holdbackDays,
      perReferrerCap: doc.perReferrerCap,
      monthlyPerReferrerCap: doc.monthlyPerReferrerCap,
      annualCreditCeilingPerUser: doc.annualCreditCeilingPerUser,
      totalBudgetCap: doc.totalBudgetCap,
      dailyVelocityPerReferrer: doc.dailyVelocityPerReferrer,
    };
  }

  private validate(dto: AdminReferralConfigDto): ConnectReferralConfigView {
    const bounded = (label: string, v: number, max: number): number => {
      if (!Number.isInteger(v) || v < 0 || v > max) {
        throw new BadRequestException(`${label} must be an integer between 0 and ${max}`);
      }
      return v;
    };
    return {
      enabled: !!dto.enabled,
      referrerCredits: bounded('referrerCredits', dto.referrerCredits, GUARDRAILS.creditMax),
      refereeCredits: bounded('refereeCredits', dto.refereeCredits, GUARDRAILS.creditMax),
      holdbackDays: bounded('holdbackDays', dto.holdbackDays, GUARDRAILS.holdbackMax),
      perReferrerCap: bounded('perReferrerCap', dto.perReferrerCap, GUARDRAILS.capMax),
      monthlyPerReferrerCap: bounded(
        'monthlyPerReferrerCap',
        dto.monthlyPerReferrerCap,
        GUARDRAILS.capMax,
      ),
      annualCreditCeilingPerUser: bounded(
        'annualCreditCeilingPerUser',
        dto.annualCreditCeilingPerUser,
        GUARDRAILS.ceilingMax,
      ),
      totalBudgetCap: bounded('totalBudgetCap', dto.totalBudgetCap, GUARDRAILS.budgetMax),
      dailyVelocityPerReferrer: bounded(
        'dailyVelocityPerReferrer',
        dto.dailyVelocityPerReferrer,
        GUARDRAILS.velocityMax,
      ),
    };
  }
}
