import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Admin per-user Connect entitlement override (PUT body).
 *
 * Every field is OPTIONAL — a partial override. Only the fields actually present
 * in the body become overrides; absent fields fall through to the plan's applied
 * entitlements (see ConnectAllowanceService.getAllowances merge). An empty body
 * therefore clears the connect override entirely (same as DELETE).
 *
 * Validation mirrors the entitlement schema (plan.schema.ts PlanConnectEntitlements
 * + the resolved ConnectAllowances shape): every numeric allowance accepts `-1`
 * (unlimited) and up, the policy is the same two-value enum, and the grace window
 * is bounded to a sane range. The service additionally whitelists only these keys
 * when persisting, so no arbitrary key can leak into entitlementsOverride.connect.
 *
 * Linked to: admin-connect-entitlements.service.ts,
 * connect/monetization/connect-allowance.service.ts (ConnectAllowances).
 */
export class AdminConnectEntitlementsOverrideDto {
  /** Max active marketplace listings. -1 = unlimited. */
  @IsOptional() @IsInt() @Min(-1) maxListings?: number;

  /** Buyer inquiries / contact unlocks per cycle. -1 = unlimited. */
  @IsOptional() @IsInt() @Min(-1) leadsPerMonth?: number;

  /** Company Pages the person may own. -1 = unlimited. */
  @IsOptional() @IsInt() @Min(-1) maxCompanyPages?: number;

  /** Storefronts the person may own. -1 = unlimited. */
  @IsOptional() @IsInt() @Min(-1) maxStorefronts?: number;

  /** Open job posts at once. -1 = unlimited. */
  @IsOptional() @IsInt() @Min(-1) maxJobs?: number;

  /** Per-person Connect media storage cap (MB). -1 = unlimited. */
  @IsOptional() @IsInt() @Min(-1) storageMb?: number;

  /** Boost credits granted into the Connect wallet each cycle. -1 = unlimited. */
  @IsOptional() @IsInt() @Min(-1) includedBoostCredits?: number;

  /** Marketplace search ranking weight. Higher = ranked higher. */
  @IsOptional() @IsInt() @Min(-1) searchPriority?: number;

  /** Eligible for the verified marker (still gated on real verification). */
  @IsOptional() @IsBoolean() verifiedBadge?: boolean;

  /** Over-limit (grandfathering) policy. */
  @IsOptional() @IsEnum(['freeze', 'hide_newest']) overLimitPolicy?: 'freeze' | 'hide_newest';

  /** Grace days before hide_newest suppresses anything. Bounded [0, 3650]. */
  @IsOptional() @IsInt() @Min(0) @Max(3650) overLimitGraceDays?: number;
}

/** The exact set of keys an admin may override on the connect block. */
export const CONNECT_OVERRIDE_KEYS: Array<keyof AdminConnectEntitlementsOverrideDto> = [
  'maxListings',
  'leadsPerMonth',
  'maxCompanyPages',
  'maxStorefronts',
  'maxJobs',
  'storageMb',
  'includedBoostCredits',
  'searchPriority',
  'verifiedBadge',
  'overLimitPolicy',
  'overLimitGraceDays',
];
