import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PlatformAccess, Platform } from '../enums/platform-access.enum';
import { Subscription } from '../../modules/subscriptions/schemas/subscription.schema';
import { Plan } from '../../modules/subscriptions/schemas/plan.schema';

export const PLATFORM_ACCESS_KEY = 'platformAccess';
export const PLATFORM_BYPASS_KEY = 'platformBypass';

export const PlatformPreview = () => {
  return (
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    if (propertyKey && descriptor) {
      Reflect.defineMetadata(PLATFORM_ACCESS_KEY, true, descriptor.value);
    } else if (propertyKey) {
      Reflect.defineMetadata(
        PLATFORM_ACCESS_KEY,
        true,
        target,
        propertyKey as string,
      );
    } else {
      Reflect.defineMetadata(PLATFORM_ACCESS_KEY, true, target);
    }
  };
};

export const PlatformBypass = () => {
  return (
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    if (propertyKey && descriptor) {
      Reflect.defineMetadata(PLATFORM_BYPASS_KEY, true, descriptor.value);
    } else if (propertyKey) {
      Reflect.defineMetadata(
        PLATFORM_BYPASS_KEY,
        true,
        target,
        propertyKey as string,
      );
    } else {
      Reflect.defineMetadata(PLATFORM_BYPASS_KEY, true, target);
    }
  };
};

@Injectable()
export class PlatformAccessGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const isPreview = this.reflector.getAllAndOverride<boolean>(
      PLATFORM_ACCESS_KEY,
      [handler],
    );
    const isBypass = this.reflector.getAllAndOverride<boolean>(
      PLATFORM_BYPASS_KEY,
      [handler],
    );

    if (isBypass) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const platform =
      (request.headers['x-platform'] as Platform) || Platform.WEB;

    if (!user || !user.sub) {
      return true;
    }

    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(user.sub),
        status: { $in: ['active', 'trial'] },
      })
      .populate<{ planId: Plan }>('planId')
      .exec();

    if (!subscription) {
      return true;
    }

    const plan = subscription.planId as unknown as {
      entitlements?: { platformAccess: PlatformAccess; maxSessions: number };
    };
    const entitlements = plan?.entitlements;
    const platformAccess = entitlements?.platformAccess || PlatformAccess.BOTH;

    if (platformAccess === PlatformAccess.BOTH) {
      return true;
    }

    const allowed =
      platformAccess === PlatformAccess.WEB_ONLY
        ? platform === Platform.WEB
        : platform === Platform.MOBILE;

    if (!allowed) {
      const platformName =
        platformAccess === PlatformAccess.WEB_ONLY ? 'web' : 'mobile';
      throw new ForbiddenException(
        `Your current plan only allows access via ${platformName}. Please upgrade to access on both platforms.`,
      );
    }

    return true;
  }
}
