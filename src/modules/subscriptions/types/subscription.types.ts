import { Subscription } from '../schemas/subscription.schema';
import { Plan, PlanEntitlements } from '../schemas/plan.schema';

export interface MySubscriptionResult {
  subscription: Subscription | null;
  plan: Plan | null;
  entitlements: PlanEntitlements | null;
  usage: {
    currentWorkspaceCount: number;
    currentTotalMembers: number;
  };
}
