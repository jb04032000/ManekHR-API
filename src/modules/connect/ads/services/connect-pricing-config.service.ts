import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ConnectPricingConfig,
  type ConnectPricingConfigDocument,
  type ConnectPricingView,
  CONNECT_PRICING_DEFAULTS,
} from '../schemas/connect-pricing-config.schema';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import type { AdminPricingConfigDto } from '../dto/admin-pricing-config.dto';

const SINGLETON_KEY = 'default';

/**
 * Hard guardrail bounds. Admins tune the live values WITHIN these; they cannot
 * set a value that would break delivery or charging (e.g. a zero/negative bid,
 * a 10-year campaign, or 500 preset chips). These are intentionally wide --
 * they are a safety rail, not the business policy. The business policy is the
 * live config value, freely editable inside these bounds with no deploy.
 */
const GUARDRAILS = {
  bidMin: 1,
  bidMax: 100_000,
  spotlightMultiplierMin: 1,
  spotlightMultiplierMax: 10,
  // Admin take-down review fee: a flat rupee fee, 0 (free take-down) to 500.
  moderationReviewFeeMin: 0,
  moderationReviewFeeMax: 500,
  budgetMin: 1,
  budgetMax: 1_000_000,
  durationDayMin: 1,
  durationDayMax: 365,
  listMinEntries: 1,
  listMaxEntries: 10,
  presetMin: 1,
  presetMax: 10_000_000,
} as const;

/**
 * Reads + writes the single ConnectPricingConfig business-lever document.
 *
 * Cross-module links: injected by BoostService (live bid + min-budget +
 * allowed-durations), by ConnectPricingController (public read for the web), and
 * by AdsAdminController (admin GET/PUT). Mirrors the AdPlacement admin pattern
 * (audited writes, NotFound-safe upsert).
 *
 * Caching: a short in-process TTL cache (same idea as the feed candidate cache)
 * so the hot boost path does not hit Mongo on every create; the cache is busted
 * immediately on an admin write so a price change is reflected on the very next
 * request (no deploy, no wait).
 */
@Injectable()
export class ConnectPricingConfigService {
  private readonly logger = new Logger(ConnectPricingConfigService.name);

  // Tiny in-process cache. 60s is well under any human edit cadence; an admin
  // write busts it instantly via `cached = null`, so a price change takes effect
  // on the next request regardless of TTL.
  private static readonly CACHE_TTL_MS = 60_000;
  private cached: { view: ConnectPricingView; at: number } | null = null;

  constructor(
    @InjectModel(ConnectPricingConfig.name)
    private readonly model: Model<ConnectPricingConfigDocument>,
    private readonly audit: AuditService,
  ) {}

  /**
   * Returns the live pricing view, upserting the default singleton on first
   * read so a fresh DB behaves exactly like the previous hardcoded constants.
   * Served from the short TTL cache when warm.
   */
  async getConfig(nowMs: number = Date.now()): Promise<ConnectPricingView> {
    if (this.cached && nowMs - this.cached.at < ConnectPricingConfigService.CACHE_TTL_MS) {
      return this.cached.view;
    }
    const doc = await this.model
      .findOneAndUpdate(
        { key: SINGLETON_KEY },
        { $setOnInsert: { key: SINGLETON_KEY, ...CONNECT_PRICING_DEFAULTS } },
        { new: true, upsert: true },
      )
      .exec();
    const view = this.toView(doc);
    this.cached = { view, at: nowMs };
    return view;
  }

  /**
   * Admin update. Validates every field against the hard guardrails, writes,
   * busts the cache, and audits. Returns the new live view.
   */
  async updateConfig(dto: AdminPricingConfigDto, adminUserId: string): Promise<ConnectPricingView> {
    const next = this.validateWithinGuardrails(dto);

    const doc = await this.model
      .findOneAndUpdate(
        { key: SINGLETON_KEY },
        { $set: next, $setOnInsert: { key: SINGLETON_KEY } },
        { new: true, upsert: true },
      )
      .exec();

    // Bust the cache so the change is live on the next request -- no deploy.
    this.cached = null;

    await this.audit.logEvent({
      module: AppModule.ADS,
      entityType: 'ConnectPricingConfig',
      entityId: String(doc._id),
      action: 'pricing_config_updated',
      actorId: adminUserId,
      meta: { ...next },
    });

    this.logger.log(`Connect pricing config updated by admin=${adminUserId}`);
    return this.toView(doc);
  }

  private toView(doc: ConnectPricingConfigDocument): ConnectPricingView {
    return {
      boostBidCpm: doc.boostBidCpm,
      boostBidCpc: doc.boostBidCpc,
      spotlightMultiplier: doc.spotlightMultiplier ?? CONNECT_PRICING_DEFAULTS.spotlightMultiplier,
      boostMinBudget: doc.boostMinBudget,
      // Coalesce so a pre-existing config doc (written before this field shipped)
      // reads as the shipped default instead of undefined.
      moderationReviewFee: doc.moderationReviewFee ?? CONNECT_PRICING_DEFAULTS.moderationReviewFee,
      boostDurations: [...doc.boostDurations],
      boostBudgetPresets: [...doc.boostBudgetPresets],
      walletTopupMinAmount: doc.walletTopupMinAmount,
      walletTopupPresets: [...doc.walletTopupPresets],
    };
  }

  /**
   * Throws BadRequestException if any field falls outside the hard guardrails.
   * Returns the cleaned, sorted, de-duplicated value object to persist.
   */
  private validateWithinGuardrails(dto: AdminPricingConfigDto): ConnectPricingView {
    const bid = (label: string, v: number): number => {
      if (!Number.isFinite(v) || v < GUARDRAILS.bidMin || v > GUARDRAILS.bidMax) {
        throw new BadRequestException(
          `${label} must be between ${GUARDRAILS.bidMin} and ${GUARDRAILS.bidMax}`,
        );
      }
      return v;
    };
    const budget = (label: string, v: number): number => {
      if (!Number.isFinite(v) || v < GUARDRAILS.budgetMin || v > GUARDRAILS.budgetMax) {
        throw new BadRequestException(
          `${label} must be between ${GUARDRAILS.budgetMin} and ${GUARDRAILS.budgetMax}`,
        );
      }
      return v;
    };
    const durations = (raw: number[]): number[] => {
      const cleaned = [...new Set(raw.map((n) => Math.trunc(n)))].sort((a, b) => a - b);
      if (
        cleaned.length < GUARDRAILS.listMinEntries ||
        cleaned.length > GUARDRAILS.listMaxEntries
      ) {
        throw new BadRequestException(
          `Durations must have ${GUARDRAILS.listMinEntries}-${GUARDRAILS.listMaxEntries} unique entries`,
        );
      }
      for (const d of cleaned) {
        if (d < GUARDRAILS.durationDayMin || d > GUARDRAILS.durationDayMax) {
          throw new BadRequestException(
            `Each duration must be between ${GUARDRAILS.durationDayMin} and ${GUARDRAILS.durationDayMax} days`,
          );
        }
      }
      return cleaned;
    };
    const presets = (label: string, raw: number[]): number[] => {
      const cleaned = [...new Set(raw.map((n) => Math.trunc(n)))].sort((a, b) => a - b);
      if (
        cleaned.length < GUARDRAILS.listMinEntries ||
        cleaned.length > GUARDRAILS.listMaxEntries
      ) {
        throw new BadRequestException(
          `${label} must have ${GUARDRAILS.listMinEntries}-${GUARDRAILS.listMaxEntries} unique entries`,
        );
      }
      for (const p of cleaned) {
        if (p < GUARDRAILS.presetMin || p > GUARDRAILS.presetMax) {
          throw new BadRequestException(
            `Each ${label} entry must be between ${GUARDRAILS.presetMin} and ${GUARDRAILS.presetMax}`,
          );
        }
      }
      return cleaned;
    };

    const spotlightMultiplier = ((): number => {
      const v = dto.spotlightMultiplier;
      if (
        !Number.isFinite(v) ||
        v < GUARDRAILS.spotlightMultiplierMin ||
        v > GUARDRAILS.spotlightMultiplierMax
      ) {
        throw new BadRequestException(
          `spotlightMultiplier must be between ${GUARDRAILS.spotlightMultiplierMin} and ${GUARDRAILS.spotlightMultiplierMax}`,
        );
      }
      return v;
    })();

    // Admin take-down review fee guardrail (0 = free take-down, max 500).
    const moderationReviewFee = ((): number => {
      const v = dto.moderationReviewFee;
      if (
        !Number.isFinite(v) ||
        v < GUARDRAILS.moderationReviewFeeMin ||
        v > GUARDRAILS.moderationReviewFeeMax
      ) {
        throw new BadRequestException(
          `moderationReviewFee must be between ${GUARDRAILS.moderationReviewFeeMin} and ${GUARDRAILS.moderationReviewFeeMax}`,
        );
      }
      return v;
    })();

    return {
      boostBidCpm: bid('boostBidCpm', dto.boostBidCpm),
      boostBidCpc: bid('boostBidCpc', dto.boostBidCpc),
      spotlightMultiplier,
      boostMinBudget: budget('boostMinBudget', dto.boostMinBudget),
      moderationReviewFee,
      boostDurations: durations(dto.boostDurations),
      boostBudgetPresets: presets('boostBudgetPresets', dto.boostBudgetPresets),
      walletTopupMinAmount: budget('walletTopupMinAmount', dto.walletTopupMinAmount),
      walletTopupPresets: presets('walletTopupPresets', dto.walletTopupPresets),
    };
  }
}
