import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_SKIP_PIN_UNLOCK_KEY } from '../decorators/skip-pin-unlock.decorator';
import { IS_ALLOW_WITHOUT_PIN_KEY } from '../decorators/allow-without-pin.decorator';
import { REDIS_CLIENT } from '../redis/redis.module';
import { UsersService } from '../../modules/users/users.service';
import { env } from '../../config/env';
import { appLockKey } from '../../modules/auth/utils/app-lock-key';

/**
 * App-lock (Quick PIN) guard. Runs AFTER `JwtAuthGuard` populates `req.user`
 * and enforces that an authenticated session is in one of two unlocked states:
 *   - PIN successfully verified — Redis key `unlocked:fam:${family}` present
 *     (or the legacy `unlocked:jti:${jti}` for tokens without a family claim)
 *   - First-login bootstrap grace — Redis key `setup-grace:fam:${family}` present
 *     (or the legacy `setup-grace:jti:${jti}` for tokens without a family claim)
 *     (only honoured when the user has no `pinHash` yet)
 *
 * Any other state responds 423 with `code: 'APP_LOCKED'`. The web client's
 * axios interceptor watches for that envelope and prompts the user to unlock.
 *
 * Endpoints that must remain reachable while locked (PIN setup/verify/forgot,
 * `/auth/logout`, `/auth/refresh`, `/auth/me`) carry `@SkipPinUnlock()`.
 *
 * IMPORTANT: this guard fails CLOSED on Redis errors. That diverges from
 * `JwtAuthGuard`'s denylist check which fails OPEN. Reasoning: a
 * stale-revoked-token surviving briefly through the denylist is a bounded
 * risk; bypassing app-lock during a Redis outage is an unbounded risk for
 * sensitive payroll/finance data. Do NOT "fix" this divergence.
 */
@Injectable()
export class PinUnlockGuard implements CanActivate {
  private readonly logger = new Logger(PinUnlockGuard.name);

  constructor(
    private reflector: Reflector,
    private usersService: UsersService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const skipPinUnlock = this.reflector.getAllAndOverride<boolean>(IS_SKIP_PIN_UNLOCK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipPinUnlock) return true;

    // @AllowWithoutPin — honoured ONLY in the no-PIN branch below (pre-PIN
    // onboarding, e.g. POST /workspaces to create the FIRST workspace). Read here
    // with the other route markers; a PIN-holder is unaffected by it and still
    // must unlock. See common/decorators/allow-without-pin.decorator.ts.
    const allowWithoutPin = this.reflector.getAllAndOverride<boolean>(IS_ALLOW_WITHOUT_PIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<{
      user?: { sub?: string; jti?: string; family?: string; isAdmin?: boolean };
      path?: string;
      originalUrl?: string;
      url?: string;
      query?: { category?: string };
    }>();

    // App Lock is an ERP-only protection: it guards the sensitive
    // payroll / finance / staff surfaces. The Connect product (network /
    // marketplace / jobs, served under the `/connect/*` and `/me/connect/*`
    // route namespaces) holds none of that, so a session that is App-Locked on
    // the ERP side must stay fully usable on Connect. Skip the lock for that
    // namespace. Mirrors the web shell, which gates ALL App Lock logic on
    // `mode !== 'connect'` (see crewroster-web DashboardLayout). Keep the two
    // in sync: a new Connect route is covered automatically here, but the FE
    // gate is by shell mode, not path.
    //
    // Deliberate, bounded widening of what is reachable while locked: it covers
    // ONLY the Connect namespace, never `/workspaces/:id/*` (team / salary /
    // attendance / finance) or `/admin/*`, which stay fail-closed below.
    if (isConnectRequest(request)) return true;

    // The shared upload endpoint (`/uploads/single`) is path-neutral, so the
    // path-based isConnectRequest above never matches it - but a Connect upload
    // is tagged by its `category` query param (prefixed `connect-`, e.g.
    // connect-inbox-media). App Lock is ERP-only, so a Connect-category upload
    // must stay reachable while locked (the chat photo above 423'd otherwise).
    // Bounded: ONLY connect-* categories on the upload route; ERP-category
    // uploads stay fail-closed below.
    if (isConnectUpload(request)) return true;

    // App Lock also does not gate a user's OWN product-neutral account
    // self-service: subscription, billing, payments/invoices, add-ons/credits
    // and the billing profile. These endpoints are all user-scoped (authorize on
    // `req.user.sub`), back the shared `/account/*` area (which the web shell
    // already treats as App-Lock-exempt: `appLockEnabled = mode === 'erp'`), and
    // hold a person's OWN plan/billing data - never workspace payroll/finance/
    // staff. A Connect-only user (no PIN) must be able to use them. ADMIN billing
    // lives under `/admin/*` and stays fail-closed below - it is NOT matched here.
    // Keep FE + BE in sync.
    if (isAccountSelfServiceRequest(request)) return true;

    const user = request.user;

    if (!user?.sub || !user?.jti) {
      throw new HttpException({ message: 'App is locked', code: 'APP_LOCKED' }, HttpStatus.LOCKED);
    }

    let dbUser;
    try {
      dbUser = await this.usersService.findByIdWithPinFields(user.sub);
    } catch (err) {
      this.logger.warn(
        `findByIdWithPinFields failed for user ${user.sub}: ${(err as Error)?.message ?? err}`,
      );
      throw new HttpException(
        {
          message: 'App is locked',
          code: 'APP_LOCKED',
          reason: 'user_lookup_failed',
        },
        HttpStatus.LOCKED,
      );
    }

    if (!dbUser) {
      throw new HttpException({ message: 'App is locked', code: 'APP_LOCKED' }, HttpStatus.LOCKED);
    }

    const hasPin = !!(dbUser as { pinHash?: string }).pinHash;

    try {
      if (!hasPin) {
        const graceKey = appLockKey('setup-grace', { family: user.family, jti: user.jti });
        const grace = graceKey ? await this.redis.get(graceKey) : null;
        if (grace) return true;
        // Pre-PIN onboarding escape hatch. A user who has never set a PIN must be
        // able to create their FIRST workspace (POST /workspaces, marked
        // @AllowWithoutPin) - that necessarily precedes PIN setup. Once it
        // succeeds the web shell routes them to /auth/setup-pin (pin-status +
        // pin-set are @SkipPinUnlock) so they still end up PIN-protected. This is
        // reached ONLY in the no-PIN branch, so a PIN-holder who is locked never
        // benefits from it - App Lock stays intact for established ERP users.
        // Fixes the Connect-only -> ERP path (no PIN + expired 5-min setup-grace)
        // that otherwise 423'd workspace creation. Keep in sync with the
        // @AllowWithoutPin decorator usages.
        if (allowWithoutPin) return true;
        throw new HttpException(
          {
            message: 'PIN setup required',
            code: 'APP_LOCKED',
            reason: 'pin_setup_required',
          },
          HttpStatus.LOCKED,
        );
      }

      const unlockKey = appLockKey('unlocked', { family: user.family, jti: user.jti });
      const unlocked = unlockKey ? await this.redis.get(unlockKey) : null;
      if (unlocked && unlockKey) {
        // Sliding unlock — refresh the key's TTL on every authenticated
        // request so an actively-used session never times out mid-work.
        // The TTL value (in seconds) was stamped into the Redis value at
        // unlock time so per-workspace `appLockIdleMs` overrides survive
        // round-trips. Fall back to deployment default on parse failure
        // (legacy keys written before this format may contain '1').
        const parsed = Number.parseInt(unlocked, 10);
        const refreshedTtl =
          Number.isFinite(parsed) && parsed > 0 ? parsed : Math.floor(env.appLock.idleMs / 1000);
        await this.redis
          .expire(unlockKey, refreshedTtl)
          .catch((err) =>
            this.logger.warn(
              `[PinUnlockGuard] EXPIRE refresh failed for jti ${user.jti}: ${(err as Error)?.message ?? err}`,
            ),
          );
        return true;
      }

      throw new HttpException({ message: 'App is locked', code: 'APP_LOCKED' }, HttpStatus.LOCKED);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(`Redis check failed for jti ${user.jti}: ${(err as Error)?.message ?? err}`);
      throw new HttpException(
        {
          message: 'App is locked',
          code: 'APP_LOCKED',
          reason: 'redis_unavailable',
        },
        HttpStatus.LOCKED,
      );
    }
  }
}

/**
 * True when the request targets the Connect product surface, which App Lock
 * does not protect (see canActivate). The HTTP global prefix is `api`
 * (main.ts `setGlobalPrefix('api')`), so live paths look like
 * `/api/connect/feed` or `/api/me/connect/profile/entry`; the prefix is
 * normalised away before matching. Connect controllers live under BOTH the
 * `connect/*` and `me/connect/*` route namespaces. Matching is exact-segment
 * (`/connect` or `/connect/...`) so an unrelated path that merely starts with
 * the letters "connect" cannot slip through.
 */
function isConnectRequest(req: { path?: string; originalUrl?: string; url?: string }): boolean {
  const raw = req.path ?? req.originalUrl ?? req.url ?? '';
  // Drop any query string, then strip the `api` global prefix if present.
  let p = raw.split('?')[0];
  if (p.startsWith('/api/')) p = p.slice('/api'.length);
  else if (p === '/api') p = '/';
  return (
    p === '/connect' ||
    p.startsWith('/connect/') ||
    p === '/me/connect' ||
    p.startsWith('/me/connect/')
  );
}

/**
 * True when the request is a Connect upload on the shared upload endpoint
 * (`/uploads/single`). That route is path-neutral, so isConnectRequest never
 * matches it - what makes an upload "Connect" is its `category` query param,
 * prefixed `connect-` (e.g. `connect-inbox-media`; see uploads.controller.ts).
 * App Lock is ERP-only, so a Connect-category upload must not be gated even
 * though its path is not under `/connect`. Reads the category from the parsed
 * query, falling back to the raw URL query string (req.path drops it). Keep the
 * `connect-` prefix in sync with the upload-policies categories.
 */
function isConnectUpload(req: {
  path?: string;
  originalUrl?: string;
  url?: string;
  query?: { category?: string };
}): boolean {
  const raw = req.path ?? req.originalUrl ?? req.url ?? '';
  let p = raw.split('?')[0];
  if (p.startsWith('/api/')) p = p.slice('/api'.length);
  else if (p === '/api') p = '/';
  if (p !== '/uploads/single' && !p.startsWith('/uploads/')) return false;
  let category = req.query?.category;
  if (!category) {
    const qs = (req.originalUrl ?? req.url ?? '').split('?')[1];
    if (qs) category = new URLSearchParams(qs).get('category') ?? undefined;
  }
  return !!category && category.startsWith('connect-');
}

/**
 * True when the request targets a user's OWN product-neutral account
 * self-service surface, which App Lock does not protect (see canActivate).
 * These are the namespaces behind the shared `/account/*` web area:
 *   - `subscriptions/*`  — own plan, checkout, payments/invoices, refunds,
 *                          coupons, dunning, change-plan, mandate (all user-scoped).
 *   - `add-ons/*`        — own add-ons + credit packs (incl. `add-ons/credit-pack/*`).
 *   - `users/me/billing` — own GST billing profile.
 * The `api` global prefix is normalised away before matching, and matching is
 * exact-segment so an unrelated path that merely starts with these letters
 * cannot slip through. ADMIN billing lives under `admin/*` (e.g.
 * `admin/billing/*`, `admin/subscriptions/*`) and is deliberately NOT matched -
 * it stays fail-closed. Razorpay's webhook is `@Public()` and bypasses the guard
 * earlier. Keep in sync with the web shell's account-area App-Lock exemption.
 */
function isAccountSelfServiceRequest(req: {
  path?: string;
  originalUrl?: string;
  url?: string;
}): boolean {
  const raw = req.path ?? req.originalUrl ?? req.url ?? '';
  let p = raw.split('?')[0];
  if (p.startsWith('/api/')) p = p.slice('/api'.length);
  else if (p === '/api') p = '/';
  return (
    p === '/subscriptions' ||
    p.startsWith('/subscriptions/') ||
    p === '/add-ons' ||
    p.startsWith('/add-ons/') ||
    p === '/users/me/billing' ||
    p.startsWith('/users/me/billing/')
  );
}
