import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppModule } from '../enums/modules.enum';
import { FeatureAccessLevel } from '../enums/feature-access.enum';
import { Subscription } from '../../modules/subscriptions/schemas/subscription.schema';
import { Plan } from '../../modules/subscriptions/schemas/plan.schema';
import { Workspace } from '../../modules/workspaces/schemas/workspace.schema';
import { BillingPolicyService } from '../../modules/subscriptions/billing/services/billing-policy.service';

export const REQUIRE_SUBSCRIPTION_KEY = 'requireSubscription';
export const REQUIRE_SUBFEATURE_KEY = 'requireSubFeature';
export const MINIMUM_ACCESS_KEY = 'minimumAccess';

interface RequireSubscriptionOptions {
  module: AppModule;
  subFeature?: string;
  minimumAccess?: FeatureAccessLevel;
}

type RequireSubscriptionMetadata = RequireSubscriptionOptions | RequireSubscriptionOptions[];

export const RequireSubscription = (options: RequireSubscriptionOptions) => {
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    const metadataTarget = propertyKey && descriptor ? descriptor.value : target;
    const metadataPropertyKey = propertyKey && !descriptor ? (propertyKey as string) : undefined;

    const existing = metadataPropertyKey
      ? Reflect.getMetadata(REQUIRE_SUBSCRIPTION_KEY, metadataTarget, metadataPropertyKey)
      : Reflect.getMetadata(REQUIRE_SUBSCRIPTION_KEY, metadataTarget);

    const nextValue = Array.isArray(existing)
      ? [...existing, options]
      : existing
        ? [existing, options]
        : [options];

    if (propertyKey && descriptor) {
      Reflect.defineMetadata(REQUIRE_SUBSCRIPTION_KEY, nextValue, descriptor.value);
    } else if (propertyKey) {
      Reflect.defineMetadata(REQUIRE_SUBSCRIPTION_KEY, nextValue, target, propertyKey as string);
    } else {
      Reflect.defineMetadata(REQUIRE_SUBSCRIPTION_KEY, nextValue, target);
    }
  };
};

interface CachedSubscription {
  subscription: any;
  entitlements: any;
  plan: any;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express Request augmentation requires namespace merging
  namespace Express {
    interface Request {
      _cachedSubscription?: CachedSubscription;
      _featureAccess?: {
        level: FeatureAccessLevel;
        module: AppModule;
        subFeature?: string;
      };
    }
  }
}

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
    @InjectModel(Workspace.name)
    private workspaceModel: Model<Workspace>,
    private readonly billingPolicy: BillingPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controllerClass = context.getClass();

    // Wave 4: read both method-level and class-level metadata and merge.
    // Class-level @RequireSubscription is the dominant pattern across
    // recent controllers (portal-token, fiscal-year, tally-export, jw-*,
    // inventory/*, all Wave-4 finance gates) — without merging here those
    // class-level decorators silently no-op.
    const methodMetadata =
      this.reflector.get<RequireSubscriptionMetadata>(REQUIRE_SUBSCRIPTION_KEY, handler) ?? [];
    const classMetadata =
      this.reflector.get<RequireSubscriptionMetadata>(REQUIRE_SUBSCRIPTION_KEY, controllerClass) ??
      [];

    const flatten = (m: RequireSubscriptionMetadata): RequireSubscriptionOptions[] =>
      Array.isArray(m) ? m : [m];
    const requirements = [...flatten(methodMetadata), ...flatten(classMetadata)];

    if (requirements.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.sub) {
      throw new UnauthorizedException('User not authenticated');
    }

    const entitlements = await this.getEntitlements(request, user.sub);

    if (!entitlements) {
      throw new ForbiddenException('No active plan. Please choose a plan to continue.');
    }

    // D1g — grace-period read-only enforcement. When the cached
    // subscription is in grace AND the policy mandates read-only
    // mode, every non-GET request is blocked until the customer
    // restores billing. Reads stay open so the dashboard remains
    // useful (banner + payment-update CTA).
    const cachedSub = request._cachedSubscription?.subscription;
    if (cachedSub?.status === 'grace_period' && request.method !== 'GET') {
      const policy = await this.billingPolicy.getPolicy();
      if (policy.gracePeriod?.readOnlyMode !== false) {
        const expiresAt = cachedSub.gracePeriodUntil
          ? new Date(cachedSub.gracePeriodUntil).toISOString()
          : 'soon';
        const salesContact =
          policy.salesContactEmail || policy.salesContactPhone
            ? ` Need help? ${policy.salesContactEmail ?? ''} ${policy.salesContactPhone ?? ''}`.trim()
            : '';
        throw new ForbiddenException(
          `Your account is in read-only mode while a payment issue is resolved. Update your payment method to restore write access. Grace period ends ${expiresAt}.${salesContact}`,
        );
      }
    }

    for (const requirement of requirements) {
      const { module, subFeature, minimumAccess = FeatureAccessLevel.LIMITED } = requirement;

      const moduleAccess = entitlements.moduleAccess || [];

      let moduleEntry = moduleAccess.find((entry: any) => entry.module === module);

      // Fallback: if moduleAccess is empty (legacy data), check the modules[] array.
      // This prevents a blanket 403 lockout on subscriptions created before moduleAccess was populated.
      if (!moduleEntry && moduleAccess.length === 0) {
        const legacyModules: AppModule[] = entitlements.modules || [];
        if (legacyModules.includes(module)) {
          // Module is present in the legacy list — treat as enabled with FULL sub-feature access
          moduleEntry = { module, enabled: true, subFeatures: [] };
        }
      }

      if (!moduleEntry || !moduleEntry.enabled) {
        throw new ForbiddenException(
          `Module '${module}' is not available on your current plan. Please upgrade to access.`,
        );
      }

      if (subFeature) {
        const subFeatureEntry = moduleEntry.subFeatures?.find((sf: any) => sf.key === subFeature);

        // If subFeatures is empty (legacy data fallback), treat as FULL access
        // so users are not blocked while the repair migration runs.
        const accessLevel =
          subFeatureEntry?.access ||
          (moduleEntry.subFeatures?.length === 0
            ? FeatureAccessLevel.FULL
            : FeatureAccessLevel.LOCKED);

        if (accessLevel === FeatureAccessLevel.LOCKED) {
          throw new ForbiddenException(
            `Feature '${subFeature}' in module '${module}' is not available on your current plan.`,
          );
        }

        if (minimumAccess === FeatureAccessLevel.FULL && accessLevel !== FeatureAccessLevel.FULL) {
          throw new ForbiddenException(
            `Feature '${subFeature}' in module '${module}' requires full access. Your current access is limited.`,
          );
        }

        request._featureAccess = {
          level: accessLevel,
          module,
          subFeature,
        };
      }
    }

    return true;
  }

  private async getEntitlements(request: Request, userId: string): Promise<any> {
    if (request._cachedSubscription) {
      return request._cachedSubscription.entitlements;
    }

    // Resolve the workspace id across every controller param convention —
    // `:workspaceId` (workspaces controller), `:wsId` (leave / attendance /
    // regularization / most tenant controllers), then `:id`, then header.
    // Mirrors `RolesGuard.resolveWorkspaceId`. Previously only `:workspaceId`
    // was read, so on a `:wsId` route this stayed undefined, the owner-pivot
    // below was skipped, and a non-owner member was checked against THEIR OWN
    // (absent) subscription — 403 "No active plan" on every gated `:wsId`
    // route. The plan lives on the workspace owner, so resolve + pivot to it.
    const rawWorkspaceId =
      request.params.workspaceId ||
      request.params.wsId ||
      request.params.id ||
      request.headers['x-workspace-id'];
    const workspaceId = Array.isArray(rawWorkspaceId) ? rawWorkspaceId[0] : rawWorkspaceId;
    let targetUserId = userId;

    if (workspaceId) {
      try {
        const workspace = await this.workspaceModel
          .findById(new Types.ObjectId(workspaceId))
          .populate<{
            ownerId: { _id: Types.ObjectId; isActive: boolean };
          }>('ownerId', 'isActive')
          .exec();

        if (workspace) {
          const owner = workspace.ownerId;
          if (owner.isActive === false) {
            throw new ForbiddenException('This workspace is currently unavailable.');
          }
          if (owner._id.toString() !== userId) {
            targetUserId = owner._id.toString();
          }
        }
      } catch (err) {
        if (err instanceof ForbiddenException) throw err;
        console.error('Error checking workspace context:', err);
      }
    }

    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(targetUserId),
        // D1g — include 'grace_period' so reads keep working while the
        // customer recovers payment. Writes are blocked downstream by
        // the canActivate read-only check.
        status: { $in: ['active', 'trial', 'cancelled', 'grace_period'] },
      })
      .sort({ createdAt: -1 })
      .populate<{ planId: Plan }>('planId')
      .exec();

    if (!subscription) {
      console.warn(
        `[SubscriptionGuard] No subscription found for userId=${targetUserId} (jwtUserId=${userId}, workspaceId=${workspaceId})`,
      );
      return null;
    }

    const now = new Date();
    if (subscription.currentPeriodEnd && subscription.currentPeriodEnd < now) {
      // Phase-2 ERP pricing — a lapsed TRIAL (or a free/default sub) must
      // DOWNGRADE to its plan's real limits, never lock out. The account keeps
      // Free-level access; only a paid sub that truly lapsed gets 'expired'.
      //
      // A sub is "trial/free" here if it still carries a `trialEndsAt`
      // (auto-started trial) OR if it has the entitlements to fall back to
      // (purchasedEntitlements / populated plan entitlements). In that case we
      // resolve the DOWNGRADED entitlements and return THOSE, not null.
      const baseEntitlements =
        subscription.purchasedEntitlements || (subscription.planId as any)?.entitlements || null;
      const isTrialOrFree = !!subscription.trialEndsAt || subscription.status === 'trial';

      if (baseEntitlements && (isTrialOrFree || !!subscription.purchasedEntitlements)) {
        console.warn(
          `[SubscriptionGuard] Subscription ${String(subscription._id)} trial lapsed — downgrading to base plan (no lockout)`,
        );
        // Persist the downgrade so the cron / next request sees a settled row.
        const farFuture = new Date(now);
        farFuture.setFullYear(farFuture.getFullYear() + 100);
        await this.subscriptionModel.updateOne(
          { _id: subscription._id },
          {
            $set: {
              status: 'active',
              appliedEntitlements: baseEntitlements,
              currentPeriodEnd: farFuture,
              trialEndsAt: null,
            },
          },
        );
        request._cachedSubscription = {
          subscription: {
            ...subscription.toObject(),
            status: 'active',
            appliedEntitlements: baseEntitlements,
          },
          entitlements: baseEntitlements,
          plan: subscription.planId?.toObject?.() || null,
        };
        return baseEntitlements;
      }

      // Genuinely-expired sub with no plan to fall back to — treat as today.
      console.warn(
        `[SubscriptionGuard] Subscription ${String(subscription._id)} expired: periodEnd=${String(subscription.currentPeriodEnd)}`,
      );
      await this.subscriptionModel.updateOne(
        { _id: subscription._id },
        { $set: { status: 'expired' } },
      );
      request._cachedSubscription = {
        subscription: { ...subscription.toObject(), status: 'expired' },
        entitlements: null,
        plan: null,
      };
      return null;
    }

    const entitlements =
      subscription.appliedEntitlements || (subscription.planId as any)?.entitlements || null;

    request._cachedSubscription = {
      subscription: subscription.toObject(),
      entitlements,
      plan: subscription.planId?.toObject?.() || null,
    };

    return entitlements;
  }

  static getFeatureAccess(request: Request): FeatureAccessLevel | null {
    return request._featureAccess?.level || null;
  }

  static isLimitedAccess(request: Request): boolean {
    return request._featureAccess?.level === FeatureAccessLevel.LIMITED;
  }
}
