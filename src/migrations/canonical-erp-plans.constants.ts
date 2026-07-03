/**
 * Canonical ERP plan/tier capacity + price constants — the SINGLE SOURCE OF TRUTH
 * (Phase-1 ERP pricing rework, 2026-06-23).
 *
 * Both the seed (`seed-default-tiers-and-plans.ts`, which INSERTS new tiers/plans)
 * and the reconcile migration (`reconcile-erp-plan-entitlements.service.ts`, which
 * FORCE-CORRECTS drifting existing rows) import these. Keeping the numbers in one
 * place means the seed and the migration can never disagree — so the
 * "Starter/Growth shows 5 team members" drift bug this work fixes stays fixed and
 * un-driftable.
 *
 * Owner-confirmed canonical set (2026-06-23):
 *   tier      | maxMembersPerWorkspace | maxWorkspaces | maxTotalMembers | monthly | yearly
 *   free      |  5                     |  1            |  5              |  0      | 0
 *   starter   | 25                     |  1            | 25              |  999    | 9999
 *   growth    | 100                    |  2            | 200             |  2499   | 24999
 *   business  | 500                    |  5            | 2500            |  4999   | 49999
 *   custom    | -1                     | -1            | -1              |  0      | 0
 *
 * `custom` uses -1 sentinels (unlimited / admin-defined). Enterprise is RETIRED —
 * it is intentionally ABSENT from this map (it is no longer seeded; legacy
 * Enterprise rows are deactivated by the retire-legacy-erp-plans migration). Do
 * NOT add an `enterprise` entry here.
 *
 * Prices are in INR (rupees). Yearly = ~17% off monthly × 12 (standard SaaS
 * discount), matching the seed's historical pricing comment.
 */

/** The 5 owner-confirmed canonical ERP tier keys (order = display order). */
export const CANONICAL_ERP_TIER_KEYS = ['free', 'starter', 'growth', 'business', 'custom'] as const;

export type CanonicalErpTierKey = (typeof CANONICAL_ERP_TIER_KEYS)[number];

/** Per-tier capacity caps (the fields the pricing cards read + that drift). */
export interface CanonicalErpTierCaps {
  maxMembersPerWorkspace: number;
  maxWorkspaces: number;
  maxTotalMembers: number;
}

/** Per-tier prices (rupees). */
export interface CanonicalErpPlanPrices {
  monthlyPrice: number;
  yearlyPrice: number;
}

/**
 * Canonical capacity caps per tier. Mirrors the Tier schema's
 * `defaultEntitlements` (and each ERP plan's `entitlements`) capacity fields.
 */
export const CANONICAL_ERP_TIER_CAPS: Record<CanonicalErpTierKey, CanonicalErpTierCaps> = {
  free: { maxMembersPerWorkspace: 5, maxWorkspaces: 1, maxTotalMembers: 5 },
  starter: { maxMembersPerWorkspace: 25, maxWorkspaces: 1, maxTotalMembers: 25 },
  growth: { maxMembersPerWorkspace: 100, maxWorkspaces: 2, maxTotalMembers: 200 },
  business: {
    maxMembersPerWorkspace: 500,
    maxWorkspaces: 5,
    maxTotalMembers: 2500,
  },
  custom: {
    maxMembersPerWorkspace: -1,
    maxWorkspaces: -1,
    maxTotalMembers: -1,
  },
};

/** Canonical prices per tier (rupees). */
export const CANONICAL_ERP_PLAN_PRICES: Record<CanonicalErpTierKey, CanonicalErpPlanPrices> = {
  free: { monthlyPrice: 0, yearlyPrice: 0 },
  starter: { monthlyPrice: 999, yearlyPrice: 9999 },
  growth: { monthlyPrice: 2499, yearlyPrice: 24999 },
  business: { monthlyPrice: 4999, yearlyPrice: 49999 },
  custom: { monthlyPrice: 0, yearlyPrice: 0 },
};
