import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Platform } from '../../../common/enums/platform-access.enum';

/**
 * Optional extra claims that callers may embed alongside the standard payload.
 * Today only `forgotPasswordReset: true` is consumed downstream (by the
 * claim-aware `change-password` bypass in UsersController) — see
 * `auth.types.ts` AuthJwtPayload for the full claim semantics.
 */
export interface IssueTokensExtraClaims {
  forgotPasswordReset?: true;
}

/**
 * Single source of truth for issuing access + refresh JWT pairs.
 *
 * Every token gets a unique `jti` claim so it can be independently revoked
 * via the Redis denylist (see `AuthService.revokeTokens` + the jti check in
 * `JwtAuthGuard`). Any handler that mints tokens MUST go through this
 * helper — minting tokens without `jti` silently bypasses revocation.
 */
export async function issueTokens(
  jwt: JwtService,
  config: ConfigService,
  userId: string,
  platform?: Platform,
  extraClaims?: IssueTokensExtraClaims,
  family?: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessJti = crypto.randomUUID();
  const refreshJti = crypto.randomUUID();
  // New login → fresh family. Refresh → the caller passes the existing family
  // so the whole refresh chain (and the browser + cookie token chains that
  // branch off one login) share it. App-Lock unlock is keyed to this.
  const sessionFamily = family ?? crypto.randomUUID();
  const basePayload = {
    sub: userId,
    platform: platform || Platform.WEB,
    family: sessionFamily,
    // Spread any caller-supplied claims (e.g. `forgotPasswordReset: true`).
    // Both access + refresh carry the same claims so a /auth/refresh round
    // trip preserves them until they are explicitly cleared (by reissuing
    // tokens without the claim).
    ...(extraClaims ?? {}),
  };

  const [accessToken, refreshToken] = await Promise.all([
    jwt.signAsync(
      { ...basePayload, jti: accessJti },
      {
        secret: config.get<string>('jwt.accessSecret'),
        expiresIn: config.get<string>('jwt.accessExpiry') as unknown as number,
      },
    ),
    jwt.signAsync(
      { ...basePayload, jti: refreshJti },
      {
        secret: config.get<string>('jwt.refreshSecret'),
        expiresIn: config.get<string>('jwt.refreshExpiry') as unknown as number,
      },
    ),
  ]);

  return { accessToken, refreshToken };
}
