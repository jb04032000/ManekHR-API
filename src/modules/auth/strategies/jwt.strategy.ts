import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import {
  UserClaimsCacheService,
  type CachedUserClaims,
} from '../../users/user-claims-cache.service';
import { AuthJwtPayload } from '../types/auth.types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
    private userClaimsCache: UserClaimsCacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.accessSecret'),
    });
  }

  /**
   * Resolve the minimal user fields (email / mobile / isAdmin / isActive) for
   * an authenticated request.
   *
   * OQ-2 hardening: this used to do a `usersService.findById()` Mongo
   * round-trip on EVERY authenticated request (an N+1 at launch scale). It now
   * checks a short-lived Redis cache (TTL = access-token lifetime) first and
   * only falls back to Mongo on a cache miss, re-populating the cache. The
   * cache is invalidated wherever these fields change (admin grant/revoke,
   * deactivate/restore, email/mobile verify, account erasure), so a hit is
   * always at most one access-token window stale — and `isActive` is checked
   * here so a deactivated user's still-valid token is rejected, which it was
   * NOT before (login/google checked isActive at issue time only).
   *
   * Dependency note: RBAC role resolution reads `req.user.isAdmin`; do not
   * change the returned shape without auditing every consumer of `req.user`.
   */
  async validate(payload: AuthJwtPayload) {
    const claims = await this.resolveClaims(payload.sub);
    if (!claims) {
      throw new UnauthorizedException();
    }
    // Reject a still-valid token for a deactivated/erased account. Previously
    // only login()/googleAuth() checked isActive (at issue time), so a
    // deactivation mid-session left the old access token usable until expiry.
    if (!claims.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }
    return {
      sub: payload.sub,
      email: claims.email,
      mobile: claims.mobile,
      isAdmin: claims.isAdmin,
      platform: payload.platform,
      jti: payload.jti,
      family: payload.family,
      // Embedded by `finalizeAuthSuccess` when the user reached this session
      // via the SMS-OTP forgot-password flow. Authorises a one-shot bypass
      // of the "current password" check in /users/change-password — see
      // UsersController.changePassword for the consumer.
      forgotPasswordReset: payload.forgotPasswordReset === true,
    };
  }

  /**
   * Cache-first resolution of the hot-path claims. Cache hit -> no Mongo.
   * Cache miss (or Redis fail-open) -> Mongo, then re-populate the cache.
   * Returns null when the user no longer exists (token references a deleted id).
   */
  private async resolveClaims(userId: string): Promise<CachedUserClaims | null> {
    const cached = await this.userClaimsCache.get(userId);
    if (cached) return cached;

    const user = await this.usersService.findById(userId);
    if (!user) return null;

    const claims: CachedUserClaims = {
      email: user.email,
      mobile: user.mobile,
      isAdmin: user.isAdmin ?? false,
      isActive: user.isActive ?? true,
    };
    // Best-effort populate so the next request in this token window is a hit.
    await this.userClaimsCache.set(userId, claims);
    return claims;
  }
}
