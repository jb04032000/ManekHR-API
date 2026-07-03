import { Injectable } from '@nestjs/common';
import {
  ConnectAllowanceService,
  ConnectLimitKind,
} from '../monetization/connect-allowance.service';
import { UploadsService } from '../../uploads/uploads.service';
import { ConnectOverLimitService } from '../over-limit/connect-over-limit.service';

/** Usage covers the four count limits plus the (separately enforced) storage cap. */
export type ConnectUsageKind = ConnectLimitKind | 'storage';

/**
 * One usage row. `limit` of `-1` means unlimited. For count kinds `used` is a
 * whole number of live items; for `storage` `used` is MB (1-decimal) and `limit`
 * is the storage cap in MB. Same `kind` vocabulary as the creation 403 body so
 * the web side maps a blocked create straight to the matching usage row.
 *
 * Over-limit (grandfathering) fields are additive — under the default `freeze`
 * policy they only SURFACE today's behavior (existing items stay live, creation
 * blocked). See docs/connect/2026-06-12-connect-over-limit-policy.md.
 */
export interface ConnectUsageRow {
  kind: ConnectUsageKind;
  used: number;
  limit: number;
  /** used > limit (and limit != unlimited). */
  overLimit: boolean;
  /** This person's over-limit policy for this kind. */
  policy: 'freeze' | 'hide_newest';
  /** Grace days before hide_newest suppresses anything. */
  graceDays: number;
  /** Start of the current over-limit episode (ISO) or null. */
  overLimitSince: string | null;
  /** overLimitSince + graceDays (ISO) or null. */
  graceEndsAt: string | null;
  /** hide_newest + over-limit + grace elapsed → newest excess hidden from public now. */
  suppressionActive: boolean;
  /** How many items are suppressed right now (0 under freeze / within grace / storage). */
  suppressedCount: number;
}

/**
 * Read-only usage roll-up for the authenticated person across all Connect count
 * limits + storage. Powers GET /me/connect/usage.
 *
 * Counting is the SAME definition each creation path enforces:
 *  - listing      → owner's slot-occupying listings (drafts count; no hoarding loophole)
 *  - storefront   → all of the owner's storefronts (no status field)
 *  - company_page → all of the owner's company pages (no status field)
 *  - job          → owner's OPEN jobs only (closed/filled free a slot)
 *  - storage      → reuses UploadsService's own usage aggregation (never drifts)
 *
 * NOT cached on purpose: the queries are five indexed counts + one small
 * aggregate (cheap), and the endpoint must be accurate immediately after a
 * create/delete (a TTL cache would report stale usage right after a change).
 */
@Injectable()
export class ConnectUsageService {
  constructor(
    private readonly allowances: ConnectAllowanceService,
    private readonly uploads: UploadsService,
    // Counts the four item kinds, reconciles the grace clock, and fires the
    // once-per-episode over-limit notice (lazy reconcile on this read path).
    private readonly overLimit: ConnectOverLimitService,
  ) {}

  async getUsageForUser(userId: string): Promise<ConnectUsageRow[]> {
    const [allow, kindStatuses, storageUsedMb] = await Promise.all([
      this.allowances.getAllowances(userId),
      // Single source of per-kind counting + over-limit state for the four count
      // limits (listing/storefront/company_page/job). Counting lives in the
      // over-limit service so used/limit and the suppression math never diverge.
      this.overLimit.reconcileUser(userId),
      this.uploads.getConnectStorageUsedMb(userId),
    ]);

    const rows: ConnectUsageRow[] = kindStatuses.map((s) => ({
      kind: s.kind,
      used: s.used,
      limit: s.limit,
      overLimit: s.overLimit,
      policy: s.policy,
      graceDays: s.graceDays,
      overLimitSince: s.overLimitSince,
      graceEndsAt: s.graceEndsAt,
      suppressionActive: s.suppressionActive,
      suppressedCount: s.suppressedCount,
    }));

    // Storage is enforced separately (UploadsService) and has no item set to
    // suppress — surface overLimit for parity but never any suppression.
    const storageOver = allow.storageMb !== -1 && storageUsedMb > allow.storageMb;
    rows.push({
      kind: 'storage',
      used: storageUsedMb,
      limit: allow.storageMb,
      overLimit: storageOver,
      policy: allow.overLimitPolicy,
      graceDays: allow.overLimitGraceDays,
      overLimitSince: null,
      graceEndsAt: null,
      suppressionActive: false,
      suppressedCount: 0,
    });

    return rows;
  }
}
