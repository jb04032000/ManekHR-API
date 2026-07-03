import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PortalTokenService } from './portal-token.service';

/**
 * PortalTokenGuard — guards every public /portal/* endpoint.
 *
 * Reads `X-Portal-Token` header, runs PortalTokenService.verify, and attaches
 * the resulting context to `req.portalContext`. The PortalContextDecorator
 * pulls it back out in handler params.
 *
 * NOTE: This guard runs on @Public() endpoints (PortalPublicController is
 * marked @Public() so the global JwtAuthGuard skips it). The guard is the
 * sole authentication gate for portal traffic.
 */
@Injectable()
export class PortalTokenGuard implements CanActivate {
  constructor(private readonly tokens: PortalTokenService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const headerVal =
      req.headers['x-portal-token'] ??
      req.headers['X-Portal-Token'] ??
      undefined;
    const token = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (!token) {
      throw new UnauthorizedException('Missing X-Portal-Token');
    }
    req.portalContext = await this.tokens.verify(String(token));
    return true;
  }
}
