export enum PlanTier {
  FREE = 'free',
  STARTER = 'starter',
  GROWTH = 'growth',
  BUSINESS = 'business',
  ENTERPRISE = 'enterprise',
  CUSTOM = 'custom', // Used for custom admin-assigned plans (plan stored in DB, not this enum)
}

export const TIER_ORDER: Record<PlanTier, number> = {
  [PlanTier.FREE]: 0,
  [PlanTier.STARTER]: 1,
  [PlanTier.GROWTH]: 2,
  [PlanTier.BUSINESS]: 3,
  [PlanTier.ENTERPRISE]: 4,
  [PlanTier.CUSTOM]: 5,
};

export function getTierLevel(tier: PlanTier): number {
  return TIER_ORDER[tier] ?? 0;
}
