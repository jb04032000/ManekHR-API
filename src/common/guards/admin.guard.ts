import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class IsAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 2026-05-22: honor @Public() the same way JwtAuthGuard does. A
    // controller can mix admin-only routes with @Public() routes (e.g.
    // LocalizationController exposes a public GET /languages used by the
    // language switcher for ALL users, while the rest of the controller is
    // admin-only). Without this check the controller-level IsAdminGuard
    // still ran on the public route and 403'd every non-admin member -
    // which, under Next 16's dev server, surfaced as a server-action 500
    // that triggered a route recompile + remount loop (infinite re-render
    // on the invited-workspace dashboard, since the language fetch lives in
    // TopHeader).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user?.isAdmin) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
