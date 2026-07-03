import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { Listing } from '../marketplace/schemas/listing.schema';
import { Storefront } from '../entities/schemas/storefront.schema';
import { CompanyPage } from '../entities/schemas/company-page.schema';
import { Job } from '../jobs/schemas/job.schema';
import { ConnectOverLimitState } from './schemas/connect-over-limit-state.schema';
import {
  ConnectAllowanceService,
  ConnectAllowances,
  ConnectLimitKind,
} from '../monetization/connect-allowance.service';
import { NotificationsService } from '../../notifications/notifications.service';
// CN-LIM-2 kill-switch: the whole over-limit (grandfathering) feature — read-time
// suppression AND the write-side reconcile/grace-clock/notice — must honor the
// SAME master flag the creation gates use (CONNECT_LIMITS_ENFORCED). Read at call
// time so a deploy toggle / test override applies immediately. Reuses the exact
// env-loader field the creation gates read (`ConnectAllowanceService.limitsEnforced`
// -> env.connectLimits.enforced) — one source of truth, no second way to read it.
import { env } from '../../../config/env';
// Single source of truth for slot-occupying listing statuses, shared with
// listing.service.ts so the create-path count and the over-limit "used" count
// can never drift.
import { LISTING_SLOT_STATUSES as MARKETPLACE_LISTING_SLOT_STATUSES } from '../marketplace/marketplace.constants';

// Re-exported (as a plain string[]) so existing importers of
// `connect-over-limit.service.ts#LISTING_SLOT_STATUSES` keep working unchanged.
export const LISTING_SLOT_STATUSES: string[] = [...MARKETPLACE_LISTING_SLOT_STATUSES];

const UNLIMITED = -1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The four count kinds, in stable usage order. Storage is NOT here — it has no
 *  item set to suppress and is handled inline by the usage service. */
export const OVER_LIMIT_KINDS: ConnectLimitKind[] = [
  'listing',
  'storefront',
  'company_page',
  'job',
];

/** Plain-English plural label per kind (matches the web `connect.limits.kind` block). */
const KIND_LABEL: Record<ConnectLimitKind, string> = {
  listing: 'products',
  storefront: 'storefronts',
  company_page: 'company pages',
  job: 'open job posts',
};

/** Maps a kind to its count limit field on the resolved allowances. */
const KIND_LIMIT_FIELD: Record<ConnectLimitKind, keyof ConnectAllowances> = {
  listing: 'maxListings',
  storefront: 'maxStorefronts',
  company_page: 'maxCompanyPages',
  job: 'maxJobs',
};

/** Computed over-limit status for one kind. No persistence. */
export interface KindOverLimitStatus {
  kind: ConnectLimitKind;
  used: number;
  limit: number;
  /** used > limit (and limit != unlimited). */
  overLimit: boolean;
  policy: 'freeze' | 'hide_newest';
  graceDays: number;
  /** Start of the current episode (ISO) or null. */
  overLimitSince: string | null;
  /** overLimitSince + graceDays (ISO) or null. */
  graceEndsAt: string | null;
  /** hide_newest AND over-limit AND grace elapsed → newest excess is hidden now. */
  suppressionActive: boolean;
  /** How many items are suppressed right now (0 under freeze / within grace). */
  suppressedCount: number;
}

// ── Pure helpers (unit-tested directly) ──────────────────────────────────────

/**
 * The suppressed id set for one kind: the NEWEST `(count - limit)` items, i.e.
 * the oldest `limit` items survive. `idsNewestFirst` MUST be sorted createdAt
 * desc. Returns [] when unlimited or within limit.
 */
export function computeSuppressedIds(idsNewestFirst: string[], limit: number): string[] {
  if (limit === UNLIMITED) return [];
  if (idsNewestFirst.length <= limit) return [];
  const excess = idsNewestFirst.length - limit;
  return idsNewestFirst.slice(0, excess);
}

/** Whether the grace window has fully elapsed (suppression may begin). */
export function graceElapsed(overLimitSince: Date | null, graceDays: number, now: Date): boolean {
  if (!overLimitSince) return false;
  const endsAt = overLimitSince.getTime() + graceDays * MS_PER_DAY;
  return now.getTime() >= endsAt;
}

/**
 * Read + (lazily) reconcile a person's over-limit state, and compute the
 * read-time suppressed id sets for the public surfaces.
 *
 * SUPPRESSION IS COMPUTED, NEVER STORED (see the policy doc): the only persisted
 * state is `ConnectOverLimitState` (the grace clock + notification episode
 * marker). Delete / re-upgrade reverse suppression on the very next read because
 * the set is re-derived from live counts every time.
 */
@Injectable()
export class ConnectOverLimitService {
  private readonly logger = new Logger(ConnectOverLimitService.name);

  constructor(
    @InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
    @InjectModel(Storefront.name) private readonly storefrontModel: Model<Storefront>,
    @InjectModel(CompanyPage.name) private readonly companyPageModel: Model<CompanyPage>,
    @InjectModel(Job.name) private readonly jobModel: Model<Job>,
    @InjectModel(ConnectOverLimitState.name)
    private readonly stateModel: Model<ConnectOverLimitState>,
    private readonly allowances: ConnectAllowanceService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * CN-LIM-2: whether the over-limit feature is enabled in this environment.
   * Reads the SAME master switch the creation gates read
   * (`CONNECT_LIMITS_ENFORCED` via `env.connectLimits.enforced`), at call time so
   * a deploy toggle / test override takes effect without re-instantiating. When
   * `false` the whole feature is a no-op: nothing is suppressed on read and the
   * reconcile writes no grace clock + fires no notice — so flipping the flag off
   * disables the ENTIRE feature (creation gates + suppression + reconcile), not
   * just the creation half. Default `true` preserves today's behavior.
   */
  private limitsEnforced(): boolean {
    return env.connectLimits.enforced;
  }

  /** Mongo filter selecting the slot-occupying items of `kind` for an owner. */
  private kindFilter(kind: ConnectLimitKind, oid: Types.ObjectId): Record<string, unknown> {
    switch (kind) {
      case 'listing':
        return { ownerUserId: oid, status: { $in: LISTING_SLOT_STATUSES } };
      case 'storefront':
        return { ownerUserId: oid };
      case 'company_page':
        return { ownerUserId: oid };
      case 'job':
        return { companyUserId: oid, status: 'open' };
    }
  }

  private modelFor(kind: ConnectLimitKind): Model<any> {
    switch (kind) {
      case 'listing':
        return this.listingModel;
      case 'storefront':
        return this.storefrontModel;
      case 'company_page':
        return this.companyPageModel;
      case 'job':
        return this.jobModel;
    }
  }

  /** Owner ids (createdAt-desc) of a kind for a person, used to derive the set. */
  private async orderedIds(kind: ConnectLimitKind, oid: Types.ObjectId): Promise<string[]> {
    const rows = await this.modelFor(kind)
      .find(this.kindFilter(kind, oid))
      .select('_id')
      .sort({ createdAt: -1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return rows.map((r) => String(r._id));
  }

  /**
   * READ-ONLY suppressed id set for a public read path. Never writes state.
   *
   * Short-circuits to [] (one cheap allowance read) under the default `freeze`
   * policy / unlimited / within-limit / grace-not-elapsed, so injecting this into
   * public reads is a behavior-preserving pass-through by default. Suppression
   * requires the grace clock (`overLimitSince`) to exist — passive users whose
   * clock has not been started by the cron yet are never suppressed (fair
   * warning is guaranteed before any hiding).
   */
  async getSuppressedIds(ownerUserId: string, kind: ConnectLimitKind): Promise<string[]> {
    // CN-LIM-2 kill switch: with the master flag off, NOTHING is ever suppressed.
    // This single short-circuit covers every read-path consumer (suppressionExclusion,
    // filterSuppressed, and each surface's dropSuppressed*), so a hide_newest plan
    // stops hiding content the instant the flag is turned off.
    if (!this.limitsEnforced()) return [];
    const allow = await this.allowances.getAllowances(ownerUserId);
    if (allow.overLimitPolicy !== 'hide_newest') return [];
    const limit = allow[KIND_LIMIT_FIELD[kind]] as number;
    if (limit === UNLIMITED) return [];

    const oid = new Types.ObjectId(ownerUserId);
    const state = await this.stateModel.findOne({ userId: oid, kind }).lean().exec();
    if (!state?.overLimitSince) return [];
    if (!graceElapsed(state.overLimitSince, allow.overLimitGraceDays, new Date())) return [];

    const ids = await this.orderedIds(kind, oid);
    return computeSuppressedIds(ids, limit);
  }

  /**
   * Build a Mongo `$nin` exclusion fragment for a single-owner public read of
   * `kind`. Returns `{}` (no-op) when nothing is suppressed. Merge into the
   * existing public query: `{ ...baseQuery, ...await this.over.suppressionExclusion(owner, 'listing') }`.
   */
  async suppressionExclusion(
    ownerUserId: string,
    kind: ConnectLimitKind,
  ): Promise<Record<string, never> | { _id: { $nin: Types.ObjectId[] } }> {
    const ids = await this.getSuppressedIds(ownerUserId, kind);
    if (ids.length === 0) return {};
    return { _id: { $nin: ids.map((id) => new Types.ObjectId(id)) } };
  }

  /**
   * Drop suppressed items from a multi-owner result page (browse / search).
   * Groups by owner so each owner's set is computed once. Pass-through (a single
   * allowance read per distinct owner) under the default freeze policy.
   */
  async filterSuppressed<T>(
    items: T[],
    kind: ConnectLimitKind,
    getOwnerId: (item: T) => string | null | undefined,
    getId: (item: T) => string,
  ): Promise<T[]> {
    if (items.length === 0) return items;
    const owners = new Set<string>();
    for (const it of items) {
      const o = getOwnerId(it);
      if (o) owners.add(o);
    }
    const suppressedByOwner = new Map<string, Set<string>>();
    await Promise.all(
      Array.from(owners).map(async (owner) => {
        const ids = await this.getSuppressedIds(owner, kind);
        if (ids.length > 0) suppressedByOwner.set(owner, new Set(ids));
      }),
    );
    if (suppressedByOwner.size === 0) return items;
    return items.filter((it) => {
      const owner = getOwnerId(it);
      if (!owner) return true;
      const set = suppressedByOwner.get(owner);
      return !set || !set.has(getId(it));
    });
  }

  // ── Reconcile (writes the grace clock + fires the once-per-episode notice) ──

  /**
   * Reconcile EVERY kind for one person: start/clear the grace clock and fire the
   * once-per-episode notification on entry. Returns the per-kind computed status
   * (used by GET /me/connect/usage). Idempotent: re-running with the same live
   * state changes nothing and never re-notifies.
   */
  async reconcileUser(userId: string): Promise<KindOverLimitStatus[]> {
    // CN-LIM-2 kill switch: with the master flag off the over-limit feature is
    // fully disabled, so the reconcile writes NO grace clock and fires NO
    // once-per-episode notice (whose "your newest items will be hidden" / "you
    // can't add more" copy would be factually wrong while creation is unblocked).
    // We still return an accurate used/limit snapshot so GET /me/connect/usage
    // keeps rendering the counters — but every enforcement-derived field is inert
    // (no episode start, no grace deadline, no suppression). No DB write happens.
    if (!this.limitsEnforced()) return this.disabledStatusSnapshot(userId);

    const oid = new Types.ObjectId(userId);
    const allow = await this.allowances.getAllowances(userId);
    const now = new Date();

    const out: KindOverLimitStatus[] = [];
    for (const kind of OVER_LIMIT_KINDS) {
      const limit = allow[KIND_LIMIT_FIELD[kind]] as number;
      const used = await this.modelFor(kind).countDocuments(this.kindFilter(kind, oid)).exec();
      const overLimit = limit !== UNLIMITED && used > limit;

      const state = await this.reconcileKindState(oid, kind, overLimit, now);
      const overLimitSince = state?.overLimitSince ?? null;

      // Fire the entry notice once per episode (on transition into / first
      // observation of an active episode that has not yet been notified).
      if (overLimit && overLimitSince && !state?.notifiedAt) {
        await this.notifyEntry(userId, kind, used, limit, allow, overLimitSince);
        await this.stateModel
          .updateOne({ userId: oid, kind }, { $set: { notifiedAt: now } })
          .exec();
      }

      const graceEnds = overLimitSince
        ? new Date(overLimitSince.getTime() + allow.overLimitGraceDays * MS_PER_DAY)
        : null;
      const suppressionActive =
        overLimit &&
        allow.overLimitPolicy === 'hide_newest' &&
        graceElapsed(overLimitSince, allow.overLimitGraceDays, now);
      const suppressedCount = suppressionActive ? used - limit : 0;

      out.push({
        kind,
        used,
        limit,
        overLimit,
        policy: allow.overLimitPolicy,
        graceDays: allow.overLimitGraceDays,
        overLimitSince: overLimitSince ? overLimitSince.toISOString() : null,
        graceEndsAt: graceEnds ? graceEnds.toISOString() : null,
        suppressionActive,
        suppressedCount,
      });
    }
    return out;
  }

  /**
   * CN-LIM-2: the read-only status snapshot returned by `reconcileUser` when the
   * master flag is OFF. Reports accurate live used/limit per kind (so the usage
   * endpoint's counters stay correct) but zeroes every enforcement-derived field:
   * no episode start, no grace deadline, never suppressing. Performs NO write —
   * no grace clock, no notice — so the feature is genuinely inert. `overLimit`
   * still reflects the plain fact used > limit; the web usage view keys the grace/
   * hide messaging off `overLimitSince`/`suppressionActive`, both null/false here.
   */
  private async disabledStatusSnapshot(userId: string): Promise<KindOverLimitStatus[]> {
    const oid = new Types.ObjectId(userId);
    const allow = await this.allowances.getAllowances(userId);
    const out: KindOverLimitStatus[] = [];
    for (const kind of OVER_LIMIT_KINDS) {
      const limit = allow[KIND_LIMIT_FIELD[kind]] as number;
      const used = await this.modelFor(kind).countDocuments(this.kindFilter(kind, oid)).exec();
      out.push({
        kind,
        used,
        limit,
        overLimit: limit !== UNLIMITED && used > limit,
        policy: allow.overLimitPolicy,
        graceDays: allow.overLimitGraceDays,
        // Feature disabled → no episode, no deadline, no hiding.
        overLimitSince: null,
        graceEndsAt: null,
        suppressionActive: false,
        suppressedCount: 0,
      });
    }
    return out;
  }

  /**
   * Converge the persisted episode state for one kind. Sets `overLimitSince` on
   * entry (preserving an existing clock), clears the whole episode when back
   * under limit. Atomic upsert so the web-lazy and worker-cron paths never race
   * to create duplicates.
   */
  private async reconcileKindState(
    oid: Types.ObjectId,
    kind: ConnectLimitKind,
    overLimit: boolean,
    now: Date,
  ): Promise<ConnectOverLimitState | null> {
    if (overLimit) {
      // Start the clock only if not already running (preserve the episode start).
      // upsert + $setOnInsert handles the brand-new row; a second update only
      // sets the clock when it is currently null.
      await this.stateModel
        .updateOne(
          { userId: oid, kind },
          { $setOnInsert: { userId: oid, kind, overLimitSince: now, notifiedAt: null } },
          { upsert: true },
        )
        .exec();
      // If the row pre-existed with a null clock (episode ended then re-entered),
      // re-arm it: set the start fresh and clear the prior notice so we re-notify.
      await this.stateModel
        .updateOne(
          { userId: oid, kind, overLimitSince: null },
          { $set: { overLimitSince: now, notifiedAt: null } },
        )
        .exec();
      return this.stateModel.findOne({ userId: oid, kind }).exec();
    }
    // Under limit → end the episode (clear the clock + notice) if one was open.
    await this.stateModel
      .updateOne(
        { userId: oid, kind, overLimitSince: { $ne: null } },
        { $set: { overLimitSince: null, notifiedAt: null } },
      )
      .exec();
    return this.stateModel.findOne({ userId: oid, kind }).exec();
  }

  /** Dispatch the one-time over-limit notice for the current episode. */
  private async notifyEntry(
    userId: string,
    kind: ConnectLimitKind,
    used: number,
    limit: number,
    allow: ConnectAllowances,
    overLimitSince: Date,
  ): Promise<void> {
    const label = KIND_LABEL[kind];
    const title = `You're over your ${label} limit`;
    let message: string;
    if (allow.overLimitPolicy === 'hide_newest') {
      const graceEnds = new Date(overLimitSince.getTime() + allow.overLimitGraceDays * MS_PER_DAY);
      const deadline = graceEnds.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
      const excess = used - limit;
      message =
        `You have ${used} of ${limit} ${label}. After ${deadline}, the newest ${excess} ` +
        `will be hidden from public view until you're back within your limit. ` +
        `They stay in your account and nothing is deleted.`;
    } else {
      message = `You have ${used} of ${limit} ${label} — existing items stay live; you can't add more.`;
    }
    try {
      await this.notifications.dispatch({
        recipientId: userId,
        category: 'connect.over_limit',
        title,
        message,
        type: 'warning',
        entityType: 'connect_over_limit',
        entityId: kind,
        metadata: { kind, policy: allow.overLimitPolicy, used, limit },
      });
    } catch (err) {
      // Never let a notification failure break the reconcile / usage read.
      this.logger.error(
        `over-limit notify failed for ${userId}/${kind}: ${err instanceof Error ? err.message : String(err)}`,
      );
      Sentry.captureException(err, { tags: { module: 'connect.over_limit', op: 'notify' } });
    }
  }

  /**
   * Distinct owner ids across all four Connect item collections — the work set for
   * the nightly reconcile cron. De-duplicated across kinds.
   */
  async distinctOwnerIds(): Promise<string[]> {
    const [listingOwners, storefrontOwners, companyOwners, jobOwners] = await Promise.all([
      this.listingModel.distinct('ownerUserId').exec(),
      this.storefrontModel.distinct('ownerUserId').exec(),
      this.companyPageModel.distinct('ownerUserId').exec(),
      this.jobModel.distinct('companyUserId').exec(),
    ]);
    const set = new Set<string>();
    for (const arr of [listingOwners, storefrontOwners, companyOwners, jobOwners]) {
      for (const id of arr as Types.ObjectId[]) if (id) set.add(String(id));
    }
    return Array.from(set);
  }
}
