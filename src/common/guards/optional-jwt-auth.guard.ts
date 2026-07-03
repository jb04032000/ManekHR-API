import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Optional JWT guard for `@Public()` routes that are public-but-personalized.
 *
 * Mirrors `JwtAuthGuard` (extends passport `AuthGuard('jwt')`, strategy name
 * `'jwt'` in `src/modules/auth/strategies/jwt.strategy.ts`) but NEVER blocks:
 * `handleRequest` returns `user ?? undefined` instead of throwing on a missing
 * / invalid token. Used alongside `@Public()` so the global `JwtAuthGuard`
 * early-returns (does not run the strategy), and this method-level guard then
 * runs the strategy to populate `req.user` WHEN a valid Bearer token is
 * present, while leaving a logged-out request fully open (no 401).
 *
 * Consumer: `ConnectProfilePublicController` — the viewer id gates
 * `network`-audience "open to" intents on the public profile read.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  // Always allow the request through. The base `canActivate` runs the jwt
  // strategy (populating `req.user` on a valid token); we swallow its outcome
  // in `handleRequest` so a logged-out / bad-token caller is never blocked.
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // No / invalid token on a public route is fine — stay open.
    }
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - Type mismatch between passport and nestjs types
  handleRequest<TUser = any>(_err: any, user: TUser): TUser | undefined {
    // Return the viewer when present; never throw for a logged-out request.
    return user ?? undefined;
  }
}
