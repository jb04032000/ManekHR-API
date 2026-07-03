import { FeatureAccessLevel } from '../enums/feature-access.enum';

/**
 * Shape of the `appliedEntitlements` object stored on a Subscription document.
 * Intentionally permissive so callers can pass the raw lean doc without casting.
 */
export interface EntitlementsLike {
  /** New-style per-module access list (may be absent on legacy subscriptions). */
  moduleAccess?: Array<{
    module: string;
    enabled: boolean;
    subFeatures?: Array<{ key: string; access: string }>;
  }>;
  /** Legacy flat module list — present when moduleAccess was not yet populated. */
  modules?: string[];
}

/**
 * Pure function — no I/O, no DI.
 *
 * Resolves the effective {@link FeatureAccessLevel} for a given
 * `module → subFeatureKey` pair against a subscription's entitlements object.
 *
 * Resolution mirrors `subscription.guard.ts` §178–217 EXACTLY (including the
 * legacy fallback branch):
 *
 *  1. `entitlements` null/undefined → `LOCKED`.
 *  2. Find the `moduleAccess` entry for `module`.
 *     - If not found AND `moduleAccess` is **empty** → check the legacy
 *       `modules[]` array: if it includes `module`, synthesise an entry with
 *       `{ enabled: true, subFeatures: [] }`.
 *     - If not found and `moduleAccess` is non-empty → `LOCKED`.
 *  3. If no module entry or `enabled === false` → `LOCKED`.
 *  4. Sub-feature resolution:
 *     - `subFeatures` absent or empty → `FULL` (legacy subscription fallback,
 *       matches guard's "subFeatures empty → treat as FULL access" comment).
 *     - Entry for `subFeatureKey` absent from a **non-empty** array → `LOCKED`
 *       (matches guard: absent key with non-empty list ⇒ feature not in plan).
 *     - Entry found → coerce its `access` string to `FeatureAccessLevel`
 *       (`locked` / `limited` / `full`). Unknown values default to `LOCKED`.
 *
 * @param entitlements  The `appliedEntitlements` field of the subscription lean
 *                      document (or `null` / `undefined` when absent).
 * @param module        The module key to check (e.g. `'attendance'`).
 * @param subFeatureKey The sub-feature key to check (e.g. `'defaulter_alerts'`).
 */
export function resolveSubFeatureAccess(
  entitlements: EntitlementsLike | null | undefined,
  module: string,
  subFeatureKey: string,
): FeatureAccessLevel {
  // Step 1 — no entitlements at all
  if (!entitlements) return FeatureAccessLevel.LOCKED;

  const moduleAccess = entitlements.moduleAccess ?? [];

  // Step 2 — locate the module entry
  let moduleEntry = moduleAccess.find((e) => e.module === module);

  if (!moduleEntry && moduleAccess.length === 0) {
    // Legacy fallback: moduleAccess array absent/empty — check the flat
    // modules[] list. If the module is present there, treat it as enabled
    // with full sub-feature access (mirrors guard §184–191).
    const legacyModules: string[] = entitlements.modules ?? [];
    if (legacyModules.includes(module)) {
      moduleEntry = { module, enabled: true, subFeatures: [] };
    }
  }

  // Step 3 — module absent or disabled
  if (!moduleEntry || !moduleEntry.enabled) return FeatureAccessLevel.LOCKED;

  // Step 4 — sub-feature resolution
  const subFeatures = moduleEntry.subFeatures ?? [];

  if (subFeatures.length === 0) {
    // Legacy subscription: no subFeatures recorded → treat as FULL access
    // (guard §205–210: "subFeatures empty → treat as FULL access").
    return FeatureAccessLevel.FULL;
  }

  const sfEntry = subFeatures.find((sf) => sf.key === subFeatureKey);

  if (!sfEntry) {
    // Key absent from a non-empty subFeatures array → feature not in plan
    return FeatureAccessLevel.LOCKED;
  }

  // Coerce to enum; unknown values fall back to LOCKED
  switch (sfEntry.access as FeatureAccessLevel) {
    case FeatureAccessLevel.FULL:
      return FeatureAccessLevel.FULL;
    case FeatureAccessLevel.LIMITED:
      return FeatureAccessLevel.LIMITED;
    default:
      return FeatureAccessLevel.LOCKED;
  }
}
