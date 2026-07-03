import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Subscription } from '../../subscriptions/schemas/subscription.schema';
import { Plan } from '../../subscriptions/schemas/plan.schema';
// Master enforcement switch for the COUNT caps (default true = enforce, same as
// today). Read at call time so a per-environment toggle / test override takes
// effect without re-instantiating the service. See env.ts `connectLimits`.
import { env } from '../../../config/env';

/**
 * The countable Connect resource kinds gated by the limit system. Travels in the
 * typed 403 body (`kind`) so one consistent error shape covers all four paths and
 * the web upgrade-prompt can label itself without a per-endpoint branch.
 */
export type ConnectLimitKind = 'listing' | 'storefront' | 'company_page' | 'job';

/**
 * Canonical 403 thrown when a creation/reactivation would exceed a count cap.
 * ONE shape across every path: `{ code: 'CONNECT_LIMIT_REACHED', kind, limit,
 * used }`. `used` is the caller's current live count (== `limit` at the gate).
 * The web client keys off `code` + `kind`; `message` is a server-side fallback.
 */
export class ConnectLimitReachedException extends ForbiddenException {
  constructor(kind: ConnectLimitKind, limit: number, used: number) {
    super({
      code: 'CONNECT_LIMIT_REACHED',
      kind,
      limit,
      used,
      message: `You've used ${used} of ${limit}. Higher limits are coming soon.`,
    });
  }
}

/** The Connect (network / marketplace) allowance block. `-1` = unlimited. */
export interface ConnectAllowances {
  maxListings: number;
  leadsPerMonth: number;
  includedBoostCredits: number;
  verifiedBadge: boolean;
  searchPriority: number;
  /** How many Company Pages the person may own. `-1` = unlimited. */
  maxCompanyPages: number;
  /** How many Storefronts the person may own. `-1` = unlimited. */
  maxStorefronts: number;
  /** How many OPEN job posts the person may have at once. `-1` = unlimited. */
  maxJobs: number;
  /**
   * Per-USER storage cap (MB) for Connect media uploads (categories prefixed
   * `connect-`). `-1` = unlimited. Connect is person-centric, so storage is
   * capped per person rather than per workspace. Enforced by UploadsService.
   */
  storageMb: number;
  /**
   * Over-limit (grandfathering) policy. `freeze` (default) = existing items stay
   * live forever + creation stays blocked (today's behavior). `hide_newest` =
   * after the grace window, suppress the newest items beyond the limit from public
   * surfaces (reversible; never deletes). Consumed by ConnectOverLimitService /
   * ConnectSuppressionService.
   */
  overLimitPolicy: 'freeze' | 'hide_newest';
  /** Grace days before `hide_newest` suppresses anything. Ignored under `freeze`. */
  overLimitGraceDays: number;
}

/**
 * Safe fallback used only when neither an active Connect subscription nor a
 * seeded connect_free plan exists (fresh DB / tests). Mirrors the connect_free
 * launch values from the M0.4 seed so the service never denies a free person.
 */
export const CONNECT_FREE_DEFAULT_ALLOWANCES: ConnectAllowances = {
  maxListings: 25,
  leadsPerMonth: -1,
  includedBoostCredits: 0,
  verifiedBadge: false,
  searchPriority: 0,
  maxCompanyPages: 1,
  maxStorefronts: 1,
  maxJobs: 10,
  // Connect free-tier media storage cap. 500 MB per person; -1 = unlimited.
  storageMb: 500,
  // Default over-limit policy = freeze (today's behavior; existing items stay
  // live, creation stays blocked). 30-day grace is only meaningful under
  // hide_newest, which no seeded plan ships.
  overLimitPolicy: 'freeze',
  overLimitGraceDays: 30,
};

const UNLIMITED = -1;

/**
 * Coerce a partial/absent `connect` allowance block into a COMPLETE allowances
 * object, filling any missing field from {@link CONNECT_FREE_DEFAULT_ALLOWANCES}.
 *
 * Exported (was the service's private `normalize`) so the admin per-user
 * entitlements screen can render its "Plan defaults" column with the EXACT same
 * fill/normalization the runtime uses — one source of truth, no drift between
 * what admin sees and what enforcement applies. Pure function (no I/O).
 * Linked to: src/modules/admin/admin-connect-entitlements.service.ts.
 */
export function resolveConnectAllowances(connect?: Partial<ConnectAllowances>): ConnectAllowances {
  return {
    maxListings: connect?.maxListings ?? CONNECT_FREE_DEFAULT_ALLOWANCES.maxListings,
    leadsPerMonth: connect?.leadsPerMonth ?? CONNECT_FREE_DEFAULT_ALLOWANCES.leadsPerMonth,
    includedBoostCredits:
      connect?.includedBoostCredits ?? CONNECT_FREE_DEFAULT_ALLOWANCES.includedBoostCredits,
    verifiedBadge: connect?.verifiedBadge ?? CONNECT_FREE_DEFAULT_ALLOWANCES.verifiedBadge,
    searchPriority: connect?.searchPriority ?? CONNECT_FREE_DEFAULT_ALLOWANCES.searchPriority,
    maxCompanyPages: connect?.maxCompanyPages ?? CONNECT_FREE_DEFAULT_ALLOWANCES.maxCompanyPages,
    maxStorefronts: connect?.maxStorefronts ?? CONNECT_FREE_DEFAULT_ALLOWANCES.maxStorefronts,
    maxJobs: connect?.maxJobs ?? CONNECT_FREE_DEFAULT_ALLOWANCES.maxJobs,
    storageMb: connect?.storageMb ?? CONNECT_FREE_DEFAULT_ALLOWANCES.storageMb,
    overLimitPolicy: connect?.overLimitPolicy ?? CONNECT_FREE_DEFAULT_ALLOWANCES.overLimitPolicy,
    overLimitGraceDays:
      connect?.overLimitGraceDays ?? CONNECT_FREE_DEFAULT_ALLOWANCES.overLimitGraceDays,
  };
}

/**
 * Reads a person's Connect allowances and enforces the numeric caps.
 *
 * PERSON-CENTRIC: resolves purely by `userId` + `product: 'connect'`. It does
 * NOT call SubscriptionsService and therefore never inherits the workspace-owner
 * branch (an ERP concept that must never apply to Connect). Reads the snapshot
 * `appliedEntitlements.connect`, with any `entitlementsOverride.connect` applied
 * per-field on top, then falls back to the connect_free plan, then to a safe
 * built-in default. Consumed by the marketplace listing/lead paths (M1) and the
 * included-credits grant cron (M0.6).
 */
@Injectable()
export class ConnectAllowanceService {
  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Plan.name)
    private readonly planModel: Model<Plan>,
  ) {}

  async getAllowances(userId: string): Promise<ConnectAllowances> {
    const sub = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        // Bundle-ready: a future ERP+Connect bundle grants Connect allowances too,
        // so accept both products. The connect_free fallback below stays pinned to
        // 'connect' — bundle users always have a sub and never reach it.
        product: { $in: ['connect', 'bundle'] },
        status: { $in: ['active', 'trial'] },
      })
      .lean()
      .exec();

    if (sub) {
      const applied = (sub.appliedEntitlements as { connect?: Partial<ConnectAllowances> })
        ?.connect;
      const override = (sub.entitlementsOverride as { connect?: Partial<ConnectAllowances> })
        ?.connect;
      return resolveConnectAllowances({ ...applied, ...override });
    }

    // No active Connect subscription: fall back to the seeded connect_free plan
    // (admin-retunable) so the launch-free allowances stay the source of truth.
    const freePlan = await this.planModel
      .findOne({ product: 'connect', tier: 'connect_free', isActive: true })
      .lean()
      .exec();
    if (freePlan) {
      return resolveConnectAllowances(
        (freePlan.entitlements as { connect?: Partial<ConnectAllowances> })?.connect,
      );
    }

    return { ...CONNECT_FREE_DEFAULT_ALLOWANCES };
  }

  /**
   * Whether the COUNT caps are enforced in this environment. Read at call time
   * (not cached) so a deploy-time toggle / test override applies immediately.
   * When `false`, every assertCanCreate* below is a no-op and creation proceeds
   * regardless of count — behavior is identical to having no cap. Default `true`
   * preserves today's enforcement. Storage (storageMb) is unaffected by this flag.
   */
  private limitsEnforced(): boolean {
    return env.connectLimits.enforced;
  }

  /**
   * Throws {@link ConnectLimitReachedException} (403) when the person is at (or
   * above) their active listing cap. `-1` = unlimited. Gated by CONNECT_LIMITS_
   * ENFORCED. Called by the marketplace listing-create path (M1) before persisting,
   * AND by listing publish() when reactivating an expired/rejected listing back
   * into a slot-occupying status (reactivation == creation-equivalent).
   *
   * DRAFT NOTE: a draft occupies a slot (draft ∈ SLOT_STATUSES), so it counts
   * toward the cap — no draft-hoarding loophole.
   */
  async assertCanCreateListing(userId: string, currentCount: number): Promise<void> {
    if (!this.limitsEnforced()) return;
    const { maxListings } = await this.getAllowances(userId);
    if (maxListings !== UNLIMITED && currentCount >= maxListings) {
      throw new ConnectLimitReachedException('listing', maxListings, currentCount);
    }
  }

  /**
   * Throws {@link ConnectLimitReachedException} (403) when the person is at (or
   * above) their Company Page cap. `-1` = unlimited. Gated by CONNECT_LIMITS_
   * ENFORCED. Called by the entities create path (Phase 6) before persisting.
   */
  async assertCanCreateCompanyPage(userId: string, currentCount: number): Promise<void> {
    if (!this.limitsEnforced()) return;
    const { maxCompanyPages } = await this.getAllowances(userId);
    if (maxCompanyPages !== UNLIMITED && currentCount >= maxCompanyPages) {
      throw new ConnectLimitReachedException('company_page', maxCompanyPages, currentCount);
    }
  }

  /**
   * Throws {@link ConnectLimitReachedException} (403) when the person is at (or
   * above) their Storefront cap. `-1` = unlimited. Gated by CONNECT_LIMITS_
   * ENFORCED. Called by the entities create path (Phase 4) before persisting.
   * NOTE: the Wave 3 migration auto-creates a default storefront per existing
   * seller and must bypass this cap (a backfill, not a user create).
   */
  async assertCanCreateStorefront(userId: string, currentCount: number): Promise<void> {
    if (!this.limitsEnforced()) return;
    const { maxStorefronts } = await this.getAllowances(userId);
    if (maxStorefronts !== UNLIMITED && currentCount >= maxStorefronts) {
      throw new ConnectLimitReachedException('storefront', maxStorefronts, currentCount);
    }
  }

  /**
   * Throws {@link ConnectLimitReachedException} (403) when the person is at (or
   * above) their OPEN-job cap. `-1` = unlimited. Gated by CONNECT_LIMITS_ENFORCED.
   * Called by the jobs create path (Phase 5) before persisting; `currentCount` is
   * the person's current OPEN job count. Closing/filling a job frees a slot;
   * there is no reopen flow, so close is never creation-equivalent.
   */
  async assertCanCreateJob(userId: string, currentCount: number): Promise<void> {
    if (!this.limitsEnforced()) return;
    const { maxJobs } = await this.getAllowances(userId);
    if (maxJobs !== UNLIMITED && currentCount >= maxJobs) {
      throw new ConnectLimitReachedException('job', maxJobs, currentCount);
    }
  }

  /**
   * Whether the person can consume another lead this cycle. `-1` = unlimited.
   * Returns a boolean; the marketplace decides the soft-block + upgrade prompt
   * (M1/M2) rather than throwing here.
   */
  async canUseLead(userId: string, usedThisCycle: number): Promise<boolean> {
    const { leadsPerMonth } = await this.getAllowances(userId);
    if (leadsPerMonth === UNLIMITED) {
      return true;
    }
    return usedThisCycle < leadsPerMonth;
  }
}
