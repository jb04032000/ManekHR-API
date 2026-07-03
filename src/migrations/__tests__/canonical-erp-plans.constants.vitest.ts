/**
 * Phase-1 ERP pricing rework — canonical ERP plan/tier constants contract.
 *
 * These constants are the SINGLE SOURCE OF TRUTH for the owner-confirmed ERP
 * capacity + price set. Both the seed (`seed-default-tiers-and-plans.ts`) and the
 * reconcile migration (`reconcile-erp-plan-entitlements.service.ts`) import them,
 * so they can never disagree. This test pins the exact table so a future edit
 * can't silently drift a number (e.g. re-introducing the Starter/Growth "5 team
 * members" bug this work fixed).
 *
 * Owner-confirmed table (2026-06-23):
 *   tier      | maxMembersPerWorkspace | maxWorkspaces | maxTotalMembers | monthly | yearly
 *   free      |  5                     |  1            |  5              |  0      | 0
 *   starter   | 25                     |  1            | 25              |  999    | 9999
 *   growth    | 100                    |  2            | 200             |  2499   | 24999
 *   business  | 500                    |  5            | 2500            |  4999   | 49999
 *   custom    | -1                     | -1            | -1              |  0      | 0
 */
import { describe, it, expect } from 'vitest';
import {
  CANONICAL_ERP_TIER_CAPS,
  CANONICAL_ERP_PLAN_PRICES,
  CANONICAL_ERP_TIER_KEYS,
} from '../canonical-erp-plans.constants';

describe('Canonical ERP plan/tier constants', () => {
  it('exposes exactly the 5 canonical tier keys (no enterprise)', () => {
    expect(new Set(CANONICAL_ERP_TIER_KEYS)).toEqual(
      new Set(['free', 'starter', 'growth', 'business', 'custom']),
    );
    expect(CANONICAL_ERP_TIER_KEYS).not.toContain('enterprise');
    expect(CANONICAL_ERP_TIER_KEYS.length).toBe(5);
  });

  it('caps match the owner-confirmed table', () => {
    expect(CANONICAL_ERP_TIER_CAPS.free).toEqual({
      maxMembersPerWorkspace: 5,
      maxWorkspaces: 1,
      maxTotalMembers: 5,
    });
    expect(CANONICAL_ERP_TIER_CAPS.starter).toEqual({
      maxMembersPerWorkspace: 25,
      maxWorkspaces: 1,
      maxTotalMembers: 25,
    });
    expect(CANONICAL_ERP_TIER_CAPS.growth).toEqual({
      maxMembersPerWorkspace: 100,
      maxWorkspaces: 2,
      maxTotalMembers: 200,
    });
    expect(CANONICAL_ERP_TIER_CAPS.business).toEqual({
      maxMembersPerWorkspace: 500,
      maxWorkspaces: 5,
      maxTotalMembers: 2500,
    });
    expect(CANONICAL_ERP_TIER_CAPS.custom).toEqual({
      maxMembersPerWorkspace: -1,
      maxWorkspaces: -1,
      maxTotalMembers: -1,
    });
  });

  it('prices match the owner-confirmed table', () => {
    expect(CANONICAL_ERP_PLAN_PRICES.free).toEqual({
      monthlyPrice: 0,
      yearlyPrice: 0,
    });
    expect(CANONICAL_ERP_PLAN_PRICES.starter).toEqual({
      monthlyPrice: 999,
      yearlyPrice: 9999,
    });
    expect(CANONICAL_ERP_PLAN_PRICES.growth).toEqual({
      monthlyPrice: 2499,
      yearlyPrice: 24999,
    });
    expect(CANONICAL_ERP_PLAN_PRICES.business).toEqual({
      monthlyPrice: 4999,
      yearlyPrice: 49999,
    });
    expect(CANONICAL_ERP_PLAN_PRICES.custom).toEqual({
      monthlyPrice: 0,
      yearlyPrice: 0,
    });
  });

  it('every tier key has both a caps entry and a price entry (no orphans)', () => {
    for (const key of CANONICAL_ERP_TIER_KEYS) {
      expect(CANONICAL_ERP_TIER_CAPS[key]).toBeDefined();
      expect(CANONICAL_ERP_PLAN_PRICES[key]).toBeDefined();
    }
  });
});
