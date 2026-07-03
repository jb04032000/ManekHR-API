import {
  PlanEntitlements,
  PlanFeatures,
} from '../../subscriptions/schemas/plan.schema';
import { AddOnEntitlementDelta } from '../schemas/add-on-definition.schema';
import { FeatureAccessLevel } from '../../../common/enums/feature-access.enum';
import { AppModule } from '../../../common/enums/modules.enum';

const ACCESS_LEVEL_ORDER: Record<FeatureAccessLevel, number> = {
  [FeatureAccessLevel.LOCKED]: 0,
  [FeatureAccessLevel.LIMITED]: 1,
  [FeatureAccessLevel.FULL]: 2,
};

function getAccessLevelValue(access: string): number {
  return ACCESS_LEVEL_ORDER[access as FeatureAccessLevel] ?? 0;
}

function maxAccess(
  current: FeatureAccessLevel,
  candidate: FeatureAccessLevel,
): FeatureAccessLevel {
  return getAccessLevelValue(candidate) > getAccessLevelValue(current)
    ? candidate
    : current;
}

export function mergeEntitlements(
  base: PlanEntitlements | Record<string, any>,
  deltas: { delta: AddOnEntitlementDelta; quantity: number }[],
): PlanEntitlements {
  const baseEntitlements = base as PlanEntitlements;

  const result: PlanEntitlements = {
    maxWorkspaces: baseEntitlements.maxWorkspaces ?? 1,
    maxMembersPerWorkspace: baseEntitlements.maxMembersPerWorkspace ?? 5,
    maxTotalMembers: baseEntitlements.maxTotalMembers ?? 5,
    modules: [...(baseEntitlements.modules ?? [])],
    features: baseEntitlements.features ?? {
      export: false,
      apiAccess: false,
      advancedRbac: false,
      customRoles: false,
      shifts: false,
      bills: false,
    },
    moduleAccess: (baseEntitlements.moduleAccess ?? []).map((m) => ({
      module: m.module,
      enabled: m.enabled,
      subFeatures: (m.subFeatures ?? []).map((sf) => ({
        key: sf.key,
        access: sf.access,
      })),
    })),
    platformAccess: (baseEntitlements.platformAccess as any) ?? 'both',
    maxSessionsPerPlatform: baseEntitlements.maxSessionsPerPlatform ?? 3,
    maxSessionsTotal: baseEntitlements.maxSessionsTotal ?? 5,
    emailsPerMonth: baseEntitlements.emailsPerMonth ?? 0,
    storage: baseEntitlements.storage ?? ({} as any),
    // Credit balance survives recompute — `applyCreditPackToBalance` mutates
    // it imperatively. CREDIT_PACK deltas are intentionally NOT processed here.
    communications: baseEntitlements.communications ?? ({} as any),
  };

  for (const { delta, quantity } of deltas) {
    const q = quantity ?? 1;

    if (delta.extraWorkspaces) {
      result.maxWorkspaces += delta.extraWorkspaces * q;
    }
    if (delta.extraMembersPerWorkspace) {
      result.maxMembersPerWorkspace += delta.extraMembersPerWorkspace * q;
    }
    if (delta.extraTotalMembers) {
      result.maxTotalMembers += delta.extraTotalMembers * q;
    }
    if (delta.extraSessionsPerPlatform) {
      result.maxSessionsPerPlatform += delta.extraSessionsPerPlatform * q;
    }
    if (delta.extraSessionsTotal) {
      result.maxSessionsTotal += delta.extraSessionsTotal * q;
    }

    if (delta.targetModule) {
      const moduleVal = delta.targetModule;
      if (!result.modules.includes(moduleVal)) {
        result.modules.push(moduleVal);
      }
      const existingEntry = result.moduleAccess.find(
        (m) => m.module === moduleVal,
      );
      if (!existingEntry) {
        result.moduleAccess.push({
          module: moduleVal,
          enabled: true,
          subFeatures: [],
        });
      } else {
        existingEntry.enabled = true;
      }
    }

    if (delta.targetSubFeatureModule && delta.targetSubFeatureKey) {
      const moduleVal = delta.targetSubFeatureModule;
      let moduleEntry = result.moduleAccess.find((m) => m.module === moduleVal);
      if (!moduleEntry) {
        moduleEntry = {
          module: moduleVal,
          enabled: true,
          subFeatures: [],
        };
        result.moduleAccess.push(moduleEntry);
      }
      moduleEntry.enabled = true;

      const existingSf = moduleEntry.subFeatures.find(
        (sf) => sf.key === delta.targetSubFeatureKey,
      );
      if (existingSf) {
        existingSf.access = maxAccess(
          existingSf.access,
          delta.targetSubFeatureAccess,
        );
      } else {
        moduleEntry.subFeatures.push({
          key: delta.targetSubFeatureKey,
          access: delta.targetSubFeatureAccess,
        });
      }
    }

    if (delta.featureOverrides) {
      for (const [key, value] of Object.entries(delta.featureOverrides)) {
        if (value === true) {
          (result.features as any)[key] = true;
        }
      }
    }
  }

  return result;
}

export function calculateTotalActiveQuantity(
  purchasedAddOns: {
    addOnDefinitionId: any;
    quantity: number;
    status: string;
  }[],
  addOnDefinitionId: string | { toString(): string },
): number {
  return purchasedAddOns
    .filter(
      (pa) =>
        pa.addOnDefinitionId.toString() === addOnDefinitionId.toString() &&
        pa.status === 'active',
    )
    .reduce((sum, pa) => sum + (pa.quantity ?? 1), 0);
}
