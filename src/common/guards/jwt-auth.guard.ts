import {
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type Redis from 'ioredis';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REDIS_CLIENT } from '../redis/redis.module';
import { SessionsService } from '../../modules/sessions/sessions.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private sessionsService: SessionsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - Type mismatch between passport and nestjs types
  async handleRequest<TUser = any>(
    err: any,
    user: TUser,
    info: any,
    context: ExecutionContext,
  ): Promise<TUser> {
    if (err || !user) {
      if (err) {
        console.error(
          '[JwtAuthGuard] Passport error:',
          err?.message || err,
          info?.message,
        );
      }
      throw err || new UnauthorizedException();
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const tokenHash = this.hashToken(token);

      try {
        const isDenylisted =
          await this.sessionsService.isTokenDenylisted(tokenHash);
        if (isDenylisted) {
          throw new UnauthorizedException('Token has been revoked');
        }
      } catch (denylistErr) {
        if (denylistErr instanceof UnauthorizedException) throw denylistErr;
        console.error(
          '[JwtAuthGuard] Denylist check failed, allowing request:',
          denylistErr?.message,
        );
      }

      // jti denylist — populated by AuthService.revokeTokens on logout.
      // Independent of the sha256 token-hash denylist above so we don't
      // depend on session-doc presence for revocation.
      const jti = (user as { jti?: string })?.jti;
      if (jti) {
        try {
          const revoked = await this.redis.get(`denylist:jti:${jti}`);
          if (revoked) {
            throw new UnauthorizedException('Token has been revoked');
          }
        } catch (jtiErr) {
          if (jtiErr instanceof UnauthorizedException) throw jtiErr;
          console.error(
            '[JwtAuthGuard] jti denylist check failed, allowing request:',
            (jtiErr as Error)?.message,
          );
        }
      }
    }

    return user;
  }

  private hashToken(token: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
